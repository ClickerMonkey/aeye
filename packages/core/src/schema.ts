/**
 * Schemas in core: tool arguments and prompt outputs are `@aeye/schema`
 * (`a`) schemas — static instances whose dynamic parts are bound per call —
 * and every request is planned as a whole for the model it goes to.
 *
 * The flow of one request:
 *
 * 1. A `Prompt` binds each tool's schema with the ctx (and its output schema
 *    with the ctx and input) and puts the bound schemas on the `Request`
 *    (`ToolDefinition.parameters`, `ResponseFormat.type`).
 * 2. The provider, knowing the model, calls `prepareRequest(request, model,
 *    { speaks })`: `profileFor(model).request([...tools, output])` fits every
 *    schema of the request together (strict slots, request totals, the tool
 *    cap with its dispatcher) and never throws. The plan is pinned on the
 *    tool definitions and the response format (`plan`), templates that show
 *    schema values are rendered for it, and an output the model can't take
 *    as structured output goes into the system prompt as text.
 * 3. The provider sends `sentTools(request)` / `sentOutput(request)`.
 * 4. The Prompt decodes every answer through the same plan
 *    (`plan.decodeCall`, `plan.output.parse`), so what was sent, how the
 *    answer is decoded and what an error says can't drift apart.
 */
import Handlebars from 'handlebars';
import {
  a,
  DEFAULT_JSON_INSTRUCTION,
  familyProfile,
  LENIENT,
  ModelProfile,
  profileFor,
  registerSchemaHelpers,
  SCHEMA_DATA_KEY,
  type Bindable,
  type Bound,
  type Encoder,
  type ErrorFormatInput,
  type JsonSchema,
  type ModelLike,
  type RenderedRequest,
  type RequestEntry,
  type RequestItem,
  type RequestOptions,
} from '@aeye/schema';
import type { Message, Request, ResponseFormat, ToolDefinition } from './types';

export {
  a,
  profileFor,
  ModelProfile,
  LENIENT,
  strictPriority,
  mergeErrorFormats,
  errorFormat,
  formatErrors,
  formatIssues,
  SchemaParseError,
  SchemaDefinitionError,
  RequestLimitError,
  familyOf,
  familyProfile,
  getProfile,
  registerProfile,
} from '@aeye/schema';
export type {
  Bindable,
  Bound,
  Bundle,
  Encoder,
  ErrorDetail,
  ErrorFormat,
  ErrorFormatInput,
  Issue,
  JsonSchema,
  ModelLike,
  ParseResult,
  Profile,
  ProfileFamily,
  RenderedRequest,
  RequestEntry,
  DecodedCall,
  Adjustment,
} from '@aeye/schema';

/**
 * The schema of a free-text tool (`ToolDefinition.format`): the text arrives
 * as `input`.
 */
export const TEXT_TOOL_SCHEMA = a.object({ input: a.string() });

/**
 * Whether a schema family has a strict dialect: the built-in `openai`,
 * `anthropic`, `google` and `xai`, or one registered with
 * `registerProfile`. (`@aeye/ai` derives a model's `'toolsStrict'`
 * capability from it.)
 */
export function hasStrictFamily(family: string): boolean {
  return familyProfile(family, true).strict;
}

/** The plan of one request: every schema in it, fitted together for one model. */
export type RequestPlan = RenderedRequest;

// ============================================================================
// Schema sources: what Tool.schema / Prompt.schema accept
// ============================================================================

/**
 * A tool's argument schema: one static `a` instance (a schema or a bundle
 * whose dynamic step takes the ctx). `TParams` is inferred from it.
 */
export type ToolSchema<TParams, TCtx> = Bindable<TParams, [ctx: TCtx]> | MappedSchema<TParams, [ctx: TCtx]>;

/**
 * A prompt's output schema: one static `a` instance whose dynamic step (if
 * any) takes `(ctx, input)`. `a.string()` (with any checks) means the answer
 * is the model's text, checked against it.
 */
export type OutputSchema<TOutput, TCtx, TInput> =
  | Bindable<TOutput, [ctx: TCtx, input: TInput]>
  | MappedSchema<TOutput, [ctx: TCtx, input: TInput]>;

/**
 * A schema given to a Tool or Prompt, normalized: `bind` gives the bound
 * schema for a call. ("Not here" is `applicable`, never the schema.)
 */
export interface SchemaSource<T, A extends unknown[]> {
  bind(...args: A): Promise<Bound<T>>;
}

const SOURCE = Symbol.for('@aeye/core.schemaSource');

/**
 * A Tool / Prompt schema whose bind arguments are worked out from the
 * caller's (`mapSchemaArgs`): e.g. `@aeye/ai` binds a tool's schema with the
 * full AI context built from the partial one a call gets.
 */
export interface MappedSchema<T, A extends unknown[]> {
  readonly _out: T;
  readonly [SOURCE]: SchemaSource<T, A>;
}

/**
 * A schema bound with arguments mapped from the ones it's called with
 * (possibly async): `mapSchemaArgs(schema, async (ctx) => [await full(ctx)])`.
 * A static schema (nothing dynamic to bind) is returned as it is.
 */
export function mapSchemaArgs<T, A extends unknown[], B extends unknown[]>(
  schema: Bindable<T, A> | MappedSchema<T, A>,
  map: (...args: B) => A | Promise<A>,
): MappedSchema<T, B> | Bindable<T, B> {
  if (!(SOURCE in schema) && !(schema as { dyn?: unknown }).dyn) {
    return schema as unknown as Bindable<T, B>;
  }
  const inner = schemaSource<T, A>(schema);
  const source: SchemaSource<T, B> = { bind: async (...args: B) => inner.bind(...await map(...args)) };
  return { [SOURCE]: source } as MappedSchema<T, B>;
}

/** Normalizes a Tool / Prompt schema. */
export function schemaSource<T, A extends unknown[]>(
  schema: Bindable<T, A> | MappedSchema<T, A>,
): SchemaSource<T, A> {
  if (typeof schema === 'object' && SOURCE in schema) {
    return (schema as MappedSchema<T, A>)[SOURCE];
  }
  const bindable = schema as Bindable<T, A>;
  return { bind: async (...args: A) => bindable.bind(...args) };
}

/**
 * Whether an output schema means "answer in text": `a.string()`. The text
 * is the answer, checked against the schema.
 */
export function isTextOutput(bound: Bound<any>): boolean {
  return bound.root.kind === 'string';
}

// ============================================================================
// Planning a request
// ============================================================================

/** Options for `planRequest` / `prepareRequest`. */
export interface PlanOptions {
  /**
   * The schema families the provider can send (`'openai'`, `'anthropic'`,
   * …). A model of another family is sent lenient schemas. Default: all.
   */
  readonly speaks?: ReadonlySet<string>;
  /** The dispatcher tool's name, when a request has more tools than the provider takes (default `run_tool`). */
  readonly dispatcherName?: string;
}

/**
 * Plans every schema of a request for a model: the tools' arguments and the
 * structured output, fitted together (strict slots, request totals, the
 * provider's tool cap), never throwing. The plan is pinned on each tool
 * definition and on the response format (`plan`), so the prompt decodes the
 * answers through it. Without a model the schemas are planned lenient (the
 * code shape), which is what a prompt decodes with when no provider planned.
 */
export function planRequest(request: Pick<Request, 'tools' | 'responseFormat' | 'errorFormat'>, model?: ModelLike, opts: PlanOptions = {}): RequestPlan {
  // A model known only by its id (no capabilities at all) keeps the old default: non-strict structured output.
  const known = model && !model.capabilities ? { ...model, capabilities: ['json'] } : model;
  const target = known ? profileFor(known, opts.speaks ? { speaks: opts.speaks } : {}) : ModelProfile.of(LENIENT);
  const items: RequestItem[] = (request.tools ?? []).map(tool => ({
    kind: 'tool' as const,
    name: tool.name,
    schema: tool.parameters,
    strict: tool.strict ?? 1,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.errorFormat ? { errorFormat: tool.errorFormat } : {}),
  }));
  const format = objectFormat(request.responseFormat);
  if (format) {
    const delivery = format.schemaDelivery === 'json' || format.schemaDelivery === 'prompt' ? 'prompt'
      : format.schemaDelivery === 'structured' ? 'structured'
      : 'auto';
    items.push({
      kind: 'output',
      schema: format.type,
      strict: format.strict ?? 1,
      delivery,
      ...(format.errorFormat ? { errorFormat: format.errorFormat } : {}),
    });
  }
  const options: RequestOptions = {
    ...(opts.dispatcherName ? { dispatcherName: opts.dispatcherName } : {}),
    ...(request.errorFormat ? { errorFormat: request.errorFormat } : {}),
  };
  const plan: RequestPlan = target.request(items as readonly RequestItem[], options);
  for (const tool of request.tools ?? []) {
    tool.plan = plan;
  }
  if (format) {
    format.plan = plan;
  }
  return plan;
}

/**
 * The plan a request was prepared with: the one pinned by `prepareRequest`
 * (or `planRequest`), else a lenient plan made now (and pinned).
 */
export function requestPlan(request: Pick<Request, 'tools' | 'responseFormat' | 'errorFormat' | 'plan'>): RequestPlan {
  return request.plan
    ?? request.tools?.find(tool => tool.plan)?.plan
    ?? objectFormat(request.responseFormat)?.plan
    ?? planRequest(request);
}

/**
 * The request as a provider sends it to `model`, planned (see the top of
 * this file): the returned copy carries the plan (`plan`), its templated
 * system text is rendered for the plan's schemas, and an output schema that
 * goes as prompt text (asked for, or the model has no structured output) has
 * left the wire for the system prompt. The request itself isn't changed
 * beyond the pinned plan, so a prompt can send it again under another
 * delivery or to another model.
 *
 * @param request - The request.
 * @param model - The model it goes to (`ModelInfo` fits); `undefined` plans lenient.
 * @param opts - The families the provider speaks, the dispatcher's name.
 */
export async function prepareRequest(request: Request, model: ModelLike | undefined, opts: PlanOptions = {}): Promise<Request> {
  const plan = planRequest(request, model, opts);
  let messages = request.messages;
  const templates = request.templates;
  if (templates) {
    const content = await templates.render(plan);
    messages = messages.map(message => message === templates.message ? { ...message, content } : message);
  }
  let responseFormat = request.responseFormat;
  const output = plan.output;
  const format = objectFormat(request.responseFormat);
  if (format && output?.delivery === 'prompt') {
    responseFormat = format.schemaDelivery === 'json' ? 'json' : undefined;
    messages = withSystemText(messages, outputInstructions(output));
  }
  return { ...request, messages, responseFormat, plan };
}

/**
 * The system-prompt text that delivers an output schema as prompt text: the
 * shape the model writes, as TypeScript, and the family's JSON instruction.
 */
export function outputInstructions(entry: RequestEntry<unknown>): string {
  return `The response must be JSON of this type:\n\`\`\`ts\n${entry.rendered.typescript()}\n\`\`\`\n\n${entry.base.jsonInstruction ?? DEFAULT_JSON_INSTRUCTION}`;
}

/** A tool as a provider sends it. */
export interface SentTool {
  readonly name: string;
  readonly description?: string;
  /** The JSON Schema of its arguments, in this model's dialect. */
  readonly parameters: JsonSchema;
  /** Send with `strict: true`. */
  readonly strict: boolean;
  /** The definition it came from (`undefined` for the dispatcher). */
  readonly definition?: ToolDefinition;
  readonly entry: RequestEntry<unknown>;
}

/**
 * The tools a prepared request sends, in order: each tool sent on its own,
 * then the dispatcher when the request had more tools than the provider
 * takes (the dispatched tools are reached through it).
 */
export function sentTools(request: Request): SentTool[] {
  if (!request.tools?.length) {
    return [];
  }
  const plan = requestPlan(request);
  const byName = new Map(request.tools.map(tool => [tool.name, tool]));
  // Only the request's tools: a provider may have narrowed them after planning (`withAllowedTools`).
  return plan.sent.filter(entry => entry === plan.dispatcher || byName.has(entry.requestedName)).map(entry => {
    const definition = entry === plan.dispatcher ? undefined : byName.get(entry.requestedName);
    const description = definition ? definition.description : dispatcherDescription(plan);
    return {
      name: entry.name,
      ...(description !== undefined ? { description } : {}),
      parameters: entry.jsonSchema!,
      strict: entry.strict,
      ...(definition ? { definition } : {}),
      entry,
    };
  });
}

/** The output schema a prepared request sends as structured output (`undefined` when it has none on the wire). */
export function sentOutput(request: Request): { readonly schema: JsonSchema; readonly strict: boolean; readonly entry: RequestEntry<unknown> } | undefined {
  if (!objectFormat(request.responseFormat)) {
    return undefined;
  }
  const output = requestPlan(request).output;
  return output && output.delivery === 'structured'
    ? { schema: output.jsonSchema!, strict: output.strict, entry: output }
    : undefined;
}

function dispatcherDescription(plan: RequestPlan): string {
  const count = plan.tools.filter(entry => entry.delivery === 'dispatched').length;
  return `Calls one of ${count} more tools: name it in "tool" and give its arguments in "args".`;
}

function objectFormat(format: ResponseFormat | undefined): Extract<ResponseFormat, object> | undefined {
  return typeof format === 'object' ? format : undefined;
}

/**
 * Appends text to the first system message, or adds one.
 */
export function withSystemText(messages: Message[], text: string): Message[] {
  const index = messages.findIndex(message => message.role === 'system' && typeof message.content === 'string');
  return index === -1
    ? [{ role: 'system', content: text }, ...messages]
    : messages.map((message, i) => i === index ? { ...message, content: `${message.content}\n\n${text}` } : message);
}

// ============================================================================
// Templates: values shown as the model writes them
// ============================================================================

/**
 * Whether a render used the schema helpers or an encoder: such text depends
 * on the model, so it's rendered again once the request is planned for it.
 */
export interface TemplateTrack {
  used: boolean;
}

const TRACK_KEY = 'aeyeSchemaTrack';
const schemaHelpers: Record<string, (...args: any[]) => unknown> = {};
registerSchemaHelpers({ registerHelper: (name, fn) => { schemaHelpers[name] = fn; } });

/**
 * `{{encode value}}` and `{{schema}}` in every template core compiles (tool
 * instructions, prompt content). A template variable of the same name still
 * wins (`{{schema}}` with a `schema` input shows the input).
 */
for (const name of ['encode', 'schema'] as const) {
  Handlebars.registerHelper(name, function (this: unknown, ...args: any[]) {
    const options = args[args.length - 1];
    if (args.length === 1 && this && typeof this === 'object' && name in this) {
      return (this as Record<string, unknown>)[name];
    }
    const track = options?.data?.[TRACK_KEY] as TemplateTrack | undefined;
    if (track) track.used = true;
    return schemaHelpers[name]!.apply(this, args);
  });
}

/**
 * Renders a template core compiled with the schema helpers on: `{{encode
 * value}}` writes through `defaultName`'s schema in `plan` (a tool's own
 * arguments in its instructions, the output in a prompt).
 */
export function renderTemplate(
  template: (vars: Record<string, unknown>, options?: { data?: Record<string, unknown> }) => string,
  vars: Record<string, unknown>,
  plan: RequestPlan,
  defaultName: string | undefined,
  track?: TemplateTrack,
): string {
  return template(vars, { data: { [SCHEMA_DATA_KEY]: { target: plan, defaultName }, [TRACK_KEY]: track } });
}

/**
 * The value-only encoder of a schema in a plan (`entry.encoder`), noting its
 * use on `track`; a schema the plan doesn't have encodes in the code shape.
 */
export function trackedEncoder<T>(plan: RequestPlan, name: string, fallback: Bound<T> | undefined, track?: TemplateTrack): Encoder<T> {
  const base = (plan.has(name) ? plan.get(name as never).encoder : fallback?.render(LENIENT).encoder) as Encoder<T> | undefined;
  const missing = () => { throw new Error(`No schema named "${name}" in this request to encode with.`); };
  const fn = ((value: T, opts?: Parameters<Encoder<T>>[1]) => {
    if (track) track.used = true;
    return base ? base(value, opts) : missing();
  }) as Encoder<T>;
  (fn as { wire: Encoder<T>['wire'] }).wire = (value, path) => {
    if (track) track.used = true;
    return base ? base.wire(value, path) : missing();
  };
  return fn;
}

