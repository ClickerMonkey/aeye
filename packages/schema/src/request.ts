/**
 * One request, rendered as a whole.
 *
 * Providers limit the REQUEST, not only each schema: Anthropic allows 20
 * strict tools, 24 optional parameters and 16 union-typed parameters across
 * every strict schema in one request [ANT-SO]; OpenAI caps a request at 128
 * tools and each strict schema at 5,000 properties / 10 levels / 120,000
 * characters / 1,000 enum values [OAI-SO]. So the rendering of one schema
 * depends on the others: `planRequest` decides, for every tool's arguments
 * and the structured output together, what each schema is rendered with,
 * and records it on the schema's `RequestEntry`.
 *
 * A request ALWAYS comes back sendable, whatever it holds — tools are often
 * not known ahead of time, and an error where degrading works is worse than
 * the degradation (Phil, DESIGN.md). Nothing is thrown; every compromise is
 * recorded on its entry (`adjustments`, `reasons`) and summarized in
 * `degradations`. A caller that wants an error opts in
 * (`assertNoDegradation()`, or `{ failOnDegrade: true }`).
 *
 * Every later use of a schema — the JSON sent, decoding the answer, error
 * paths, values encoded into instructions and examples — goes through the
 * entry's ONE `Rendered`, so nothing can drift from what the model was shown.
 *
 * How a schema is fitted, in order (the first that fits wins):
 *
 * 1. the model's profile for its kind, as is;
 * 2. the same profile with absent optionals written as `null` (Anthropic:
 *    trades optional parameters for union types);
 * 3. with large enums widened to strings that list their values (fewer enum
 *    values and characters; still enforced on decode);
 * 4. with deep nesting written as JSON text (fewer levels and properties);
 * 5. not strict: the family's loose profile — the model isn't constrained,
 *    the answer is still validated by the same schema (a strict structured
 *    output on a family whose output is always strict goes as prompt text).
 *
 * Items are fitted in priority order (`strict: true` first, then higher
 * numbers; core's convention), so the most wanted schemas spend the budget
 * first. `strict: true` is the strongest preference, not a guarantee: when the
 * strict slots or totals run out, it is sent non-strict and says why.
 *
 * More tools than the provider takes: the highest-priority ones stay tools;
 * the rest go behind ONE dispatcher tool (`run_tool({ tool, args })`, a
 * `DispatchType`) whose args are the overflow tools' own schemas.
 * `decodeCall` turns a dispatcher call back into the original tool's name and
 * decoded args, so callers never see the dispatcher.
 */
import type { Bindable, Bound } from './module';
import { Bundle } from './module';
import { LENIENT, variant, type Profile, type ProfileAdjustment, type RequestLimits, type SchemaLimits, DEFAULT_JSON_INSTRUCTION } from './profile';
import type { CopyStats, EncodeTextOptions, Encoder, Issue, JsonSchema, ParseOptions, ParseResult, Rendered } from './render';
import { addMeasures, overLimits, ZERO_MEASURE, type SchemaMeasure } from './measure';
import { RequestLimitError } from './errors';
import { schemaHelpers, type HelperSet } from './template';
import { errorFormat, formatErrors, mergeErrorFormats, recordIssue, type ErrorFormat, type ErrorFormatInput } from './feedback';
import { rankNear } from './suggest';
import { AnyType, DispatchType, type AnySchema } from './schema';
import type { ModelProfile } from './model';

/** A schema in a request: a bound bundle, or a ref-free schema / static bundle. */
export type RequestSchema<Out> = Bound<Out> | Bindable<Out, []>;

/** Strict request, as core spells it: `true` most wanted, `false` refuses, a number > 0 prefers (higher first). */
export type Strictness = boolean | number;

export interface ToolItem<N extends string = string, Out = unknown> {
  readonly kind: 'tool';
  readonly name: N;
  readonly schema: RequestSchema<Out>;
  /** Default `1` (prefer strict). */
  readonly strict?: Strictness;
  /** Shown in the dispatcher's tool list if this tool ends up behind it. */
  readonly description?: string;
  /** How a bad call is told to the model (the tool definition's choice; a call can override). */
  readonly errorFormat?: ErrorFormatInput;
}

export interface OutputItem<N extends string = 'output', Out = unknown> {
  readonly kind: 'output';
  /** Default `'output'`. */
  readonly name?: N;
  readonly schema: RequestSchema<Out>;
  /** Default `1` (prefer strict). */
  readonly strict?: Strictness;
  /** `'prompt'` always sends the schema as prompt text; `'auto'` (default) only when it can't be structured. */
  readonly delivery?: 'auto' | 'structured' | 'prompt';
  /** How a bad answer is told to the model (the prompt definition's choice; a call can override). */
  readonly errorFormat?: ErrorFormatInput;
}

export type RequestItem = ToolItem<string, any> | OutputItem<string, any>;

export interface RequestOptions {
  /** Throw a `RequestLimitError` when anything had to be degraded (default false: never throw). */
  readonly failOnDegrade?: boolean;
  /** The dispatcher tool's name (default `run_tool`, made unique among the tools). */
  readonly dispatcherName?: string;
  /** The error format of every schema in the request; an item's own `errorFormat` wins over it. */
  readonly errorFormat?: ErrorFormatInput;
}

/** The name an item is looked up by. */
export type ItemName<I> = I extends { readonly kind: 'output' }
  ? (I extends { readonly name: infer N extends string } ? N : 'output')
  : I extends { readonly name: infer N extends string } ? N : never;
/** The code-shape output of an item's schema (`unknown` when the item list is computed). */
export type ItemOut<I> = I extends { readonly schema: { readonly _out: infer O } } ? (0 extends 1 & O ? unknown : O) : unknown;
/** The item named `N` (an item whose name is only known as `string` may be any of them). */
type ByName<I, N> = I extends unknown ? (N extends ItemName<I> ? I : string extends ItemName<I> ? I : never) : never;

/** One change made to the model's profile (or the item) for this schema. */
export type Adjustment =
  | { readonly kind: 'optional-as-null' }
  | { readonly kind: 'enums-widened'; readonly maxEnumValues: number }
  | { readonly kind: 'depth-limited'; readonly maxDepth: number }
  | { readonly kind: 'root-wrapped' }
  | { readonly kind: 'not-strict'; readonly reason: string }
  | { readonly kind: 'prompt-text'; readonly reason: string }
  | { readonly kind: 'renamed'; readonly from: string }
  | { readonly kind: 'dispatched'; readonly via: string; readonly reason: string };

/** Core's priority order: `true` first, `false` last, numbers by size, unset/0 → 0. */
export function strictPriority(requested: Strictness | undefined): number {
  if (requested === true) return Infinity;
  if (requested === false) return -Infinity;
  if (typeof requested === 'number') return requested > 0 ? requested : 0;
  return 0;
}

/** One schema of a rendered request: what it is rendered with, why, and its codec. */
export class RequestEntry<Out = unknown> {
  declare readonly _out: Out;
  constructor(
    readonly name: string,
    readonly kind: 'tool' | 'output',
    readonly requested: Strictness,
    /** What the model offers for this kind of schema. */
    readonly base: Profile,
    /** Exactly what this schema is rendered with (the base plus `adjustments`). */
    readonly profile: Profile,
    /** Send with `strict: true` (or as strict structured output). */
    readonly strict: boolean,
    /**
     * `structured`: sent as its own tool / response format. `prompt`: the
     * schema goes as prompt text. `dispatched`: a tool reached through the
     * dispatcher (`via`); not sent on its own.
     */
    readonly delivery: 'structured' | 'prompt' | 'dispatched',
    readonly adjustments: readonly Adjustment[],
    /** The limits that ruled out the earlier choices (empty when the base fit). */
    readonly reasons: readonly string[],
    readonly rendered: Rendered<Out>,
    /** The name the caller gave (differs from `name` only when two items shared one). */
    readonly requestedName: string = name,
    /** The dispatcher tool this tool is reached through. */
    readonly via?: string,
    /** The bound schema itself (for renderings other than `rendered`). */
    readonly boundSchema: Bound<Out> = undefined as never,
  ) {}

  /** How a bad answer is told to the model: the request's format, then the item's (`ToolItem.errorFormat`). */
  errorFormat: ErrorFormat | undefined;

  /** What the model wrote, as the error message names it: `the arguments of search`, `your answer`. */
  get label(): string {
    if (this.kind === 'output') return 'your answer';
    return this.via ? `the arguments of ${this.requestedName} (called through ${this.via})` : `the arguments of ${this.requestedName}`;
  }

  /** Parse options with this entry's error format and label (a call's own options win). */
  private opts(opts: ParseOptions | undefined): ParseOptions {
    return { ...opts, errorFormat: mergeErrorFormats(this.errorFormat, opts?.errorFormat), label: opts?.label ?? this.label };
  }

  /** The JSON Schema to send; `undefined` when the schema goes as prompt text or through the dispatcher. */
  get jsonSchema(): JsonSchema | undefined {
    return this.delivery === 'structured' ? this.rendered.jsonSchema : undefined;
  }

  /** The schema as prompt text (prompt-text delivery), with the family's JSON instruction. */
  get promptText(): string {
    return `${this.rendered.typescript()}\n\n${this.base.jsonInstruction ?? DEFAULT_JSON_INSTRUCTION}`;
  }

  /** What this schema counts toward the provider's limits. */
  get measure(): SchemaMeasure {
    return this.rendered.measure;
  }

  /** Decode the model's answer; a failure's `message` is in this entry's error format. */
  parse(wire: unknown, opts?: ParseOptions): ParseResult<Out> {
    return this.rendered.parse(wire, this.opts(opts));
  }

  parseText(text: string, opts?: Omit<ParseOptions, 'inPlace'>): ParseResult<Out> {
    return this.rendered.parseText(text, this.opts(opts));
  }

  parseOrThrow(wire: unknown, opts?: ParseOptions): Out {
    return this.rendered.parseOrThrow(wire, this.opts(opts));
  }

  /** A value as this model writes it for this schema. */
  encode(value: Out, stats?: CopyStats): unknown {
    return this.rendered.encode(value, stats);
  }

  encodeText(value: Out, opts?: EncodeTextOptions): string {
    return this.rendered.encodeText(value, opts);
  }

  /** `encode` needing only the value: for instruction functions, examples and injected values. */
  get encoder(): Encoder<Out> {
    return this.rendered.encoder;
  }

  /** Handlebars helpers bound to this schema (`{{encode value}}`, `{{schema}}`). */
  helpers(): HelperSet {
    return schemaHelpers(this);
  }
}

/** A tool call decoded back to the tool the caller registered (through the dispatcher or not). */
export type DecodedCall =
  | { readonly ok: true; readonly tool: string; readonly value: unknown; readonly via?: string }
  | { readonly ok: false; readonly tool: string | undefined; readonly issues: readonly Issue[]; readonly message: string };

/** Every schema of one request, fitted together. Always sendable. */
export class RenderedRequest<I extends readonly RequestItem[] = readonly RequestItem[]> {
  private readonly byName = new Map<string, RequestEntry<any>>();

  constructor(
    readonly target: ModelProfile,
    /** In the order the items were given (then the dispatcher, if one was needed). */
    readonly entries: readonly RequestEntry<any>[],
    /** What the strict schemas add up to (the request totals). */
    readonly used: SchemaMeasure,
    /** How many tools went strict. */
    readonly strictTools: number,
    /** The request limits that applied. */
    readonly limits: RequestLimits,
    /** Everything that was degraded to make the request fit, readable. Empty when nothing was. */
    readonly degradations: readonly string[],
    /** The dispatcher tool, when there were more tools than the provider takes. */
    readonly dispatcher?: RequestEntry<{ tool: string; args: unknown }>,
    /** Dispatched tools whose args the dispatcher took as plain JSON (named-type clash): checked on decode. */
    private readonly checkLater: ReadonlySet<string> = new Set(),
  ) {
    for (const e of entries) this.byName.set(e.name, e);
  }

  /** The entry of a tool by name, or of the output (`'output'` unless named). */
  get<N extends ItemName<I[number]>>(name: N): RequestEntry<ItemOut<ByName<I[number], N>>> {
    const e = this.byName.get(name);
    if (!e) throw new Error(`@aeye/schema: no schema named "${name}" in this request.`);
    return e;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every tool entry (dispatched ones included). */
  get tools(): readonly RequestEntry<unknown>[] {
    return this.entries.filter((e) => e.kind === 'tool');
  }

  /** The tools to SEND: each direct tool, and the dispatcher. */
  get sent(): readonly RequestEntry<unknown>[] {
    return this.entries.filter((e) => e.kind === 'tool' && e.delivery === 'structured');
  }

  get output(): RequestEntry<unknown> | undefined {
    return this.entries.find((e) => e.kind === 'output');
  }

  /**
   * Decode a tool call the model made: by the name it called and its raw
   * args (parsed JSON). A dispatcher call comes back as the ORIGINAL tool's
   * name and decoded args, with `via` naming the dispatcher.
   */
  decodeCall(name: string, args: unknown, opts?: ParseOptions): DecodedCall {
    const d = this.dispatcher;
    if (d && name === d.name) {
      // The message speaks of the tool the model meant (its own error format), not of the dispatcher.
      const named = typeof (args as { tool?: unknown })?.tool === 'string' ? this.byName.get((args as { tool: string }).tool) : undefined;
      const inner0 = named?.delivery === 'dispatched' ? named : undefined;
      const res = d.parse(args, {
        ...opts,
        errorFormat: mergeErrorFormats(d.errorFormat, inner0?.errorFormat, opts?.errorFormat),
        label: opts?.label ?? (inner0 ? inner0.label : `your call to ${d.name}`),
      });
      if (!res.ok) return { ok: false, tool: inner0?.requestedName, issues: res.issues, message: res.message };
      const inner = this.byName.get(res.value.tool)!;
      if (this.checkLater.has(inner.name)) {
        const checked = innerLenient(inner).parse(res.value.args, { ...opts, errorFormat: mergeErrorFormats(inner.errorFormat, opts?.errorFormat), label: opts?.label ?? inner.label });
        if (!checked.ok) return { ok: false, tool: inner.requestedName, issues: checked.issues, message: checked.message };
        return { ok: true, tool: inner.requestedName, value: checked.value, via: d.name };
      }
      return { ok: true, tool: inner.requestedName, value: res.value.args, via: d.name };
    }
    const e = this.byName.get(name);
    if (!e || e.kind !== 'tool') return this.unknownTool(name, opts);
    // A tool behind the dispatcher called directly (its name is in the dispatcher's list): its args
    // are written exactly as inside the dispatcher, so it is decoded, not refused.
    const res = e.parse(args, e.delivery === 'dispatched' ? { ...opts, label: opts?.label ?? `the arguments of ${e.requestedName}` } : opts);
    return res.ok ? { ok: true, tool: e.requestedName, value: res.value } : { ok: false, tool: e.requestedName, issues: res.issues, message: res.message };
  }

  /** A call to a tool the request doesn't have: the nearest name, or the list. */
  private unknownTool(name: string, opts: ParseOptions | undefined): DecodedCall {
    const names = this.entries.filter((x) => x.kind === 'tool' && x !== this.dispatcher).map((x) => x.name);
    const near = rankNear(name, names)[0];
    const hint = near !== undefined
      ? ` — did you mean \`${near}\`?`
      : ` Tools: ${names.slice(0, 30).join(', ')}${names.length > 30 ? `, … (${names.length - 30} more)` : ''}.`;
    const issue: Issue = { path: [], codePath: [], message: `No tool named "${name}" in this request.` };
    recordIssue(issue, { kind: 'tool', received: name, candidates: () => names });
    const f = errorFormat(opts?.errorFormat);
    const text = near === undefined ? `${issue.message}${hint}` : f.suggestions ? `${issue.message.replace(/\.$/, '')}${hint}` : issue.message;
    const message = text.length <= f.maxChars ? text : formatErrors([issue], undefined, { ...f, detail: 'summary' }, `your call to ${name}`);
    return { ok: false, tool: undefined, issues: [issue], message };
  }

  /** A call to a tool as this model would make it: `{ name, args }` (through the dispatcher when the tool is behind it). */
  encodeCall(tool: string, value: unknown): { name: string; args: unknown } {
    const e = this.byName.get(tool);
    if (!e) throw new Error(`@aeye/schema: no schema named "${tool}" in this request.`);
    if (e.delivery === 'dispatched' && this.dispatcher) return { name: this.dispatcher.name, args: this.dispatcher.encode({ tool: e.name, args: value }) };
    return { name: e.name, args: e.encode(value) };
  }

  /** Throw a `RequestLimitError` when anything was degraded (opt-in; requests never throw by themselves). */
  assertNoDegradation(): this {
    if (this.degradations.length) throw new RequestLimitError(this.degradations);
    return this;
  }

  /**
   * Handlebars helpers over the whole request: `{{encode value}}` uses
   * `defaultName` (a tool's own schema in its instructions, the output in a
   * prompt), `{{encode value tool="search"}}` / `{{encode value output=true}}`
   * pick another schema of the request.
   */
  helpers(defaultName?: ItemName<I[number]>): HelperSet {
    return schemaHelpers(this, defaultName);
  }
}

/** The code-shape rendering of an entry's own schema. */
function innerLenient(e: RequestEntry<unknown>): Rendered<unknown> {
  return e.boundSchema.render(LENIENT);
}

function boundOf<Out>(s: RequestSchema<Out>): Bound<Out> {
  return 'env' in s && 'root' in s ? (s as Bound<Out>) : (s as Bindable<Out, []>).bind();
}

function minLimit(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

function mergeTotals(a: SchemaLimits | undefined, b: SchemaLimits | undefined): SchemaLimits | undefined {
  if (!a) return b;
  if (!b) return a;
  const out: Record<string, number | undefined> = {};
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof SchemaLimits>) out[k] = minLimit(a[k], b[k]);
  return out as SchemaLimits;
}

/** The request limits of a target: the tighter of its tool and output profiles' (they share one budget). */
function requestLimitsOf(target: ModelProfile): RequestLimits {
  const a = target.tool.request ?? {};
  const b = target.output.request ?? {};
  const out: { -readonly [K in keyof RequestLimits]: RequestLimits[K] } = {};
  const maxTools = minLimit(a.maxTools, b.maxTools);
  const maxStrictTools = minLimit(a.maxStrictTools, b.maxStrictTools);
  const totals = mergeTotals(a.totals, b.totals);
  if (maxTools !== undefined) out.maxTools = maxTools;
  if (maxStrictTools !== undefined) out.maxStrictTools = maxStrictTools;
  if (totals) out.totals = totals;
  return out;
}

const ENUM_CAPS = [250, 100, 40, 16, 8];

/** The profiles to try for one schema, in order, after the base. */
function* candidates(base: Profile, m: SchemaMeasure, wantNull: boolean): Generator<{ profile: Profile; adj: ProfileAdjustment }> {
  const keep: ProfileAdjustment = base.rootObject ? { rootObject: true } : {};
  if (wantNull && m.optional > 0 && base.optional !== 'null') yield { profile: variant(base, { ...keep, optionalAsNull: true }), adj: { optionalAsNull: true } };
  const biggest = Math.max(0, ...m.enums.map((e) => e.values));
  let lastCap: number | undefined;
  for (const cap of ENUM_CAPS) {
    if (biggest > cap && cap < (base.maxEnumValues ?? Infinity)) {
      lastCap = cap;
      yield { profile: variant(base, { ...keep, maxEnumValues: cap }), adj: { maxEnumValues: cap } };
    }
  }
  const top = Math.min(m.depth - 1, (base.maxDepth ?? Infinity) - 1);
  for (let d = top; d >= 1; d--) {
    const adj: ProfileAdjustment = { maxDepth: d, ...(lastCap !== undefined ? { maxEnumValues: lastCap } : {}) };
    yield { profile: variant(base, { ...keep, ...adj }), adj };
  }
}

function adjustmentsOf(adj: ProfileAdjustment): Adjustment[] {
  const out: Adjustment[] = [];
  if (adj.optionalAsNull) out.push({ kind: 'optional-as-null' });
  if (adj.maxEnumValues !== undefined) out.push({ kind: 'enums-widened', maxEnumValues: adj.maxEnumValues });
  if (adj.maxDepth !== undefined) out.push({ kind: 'depth-limited', maxDepth: adj.maxDepth });
  return out;
}

/**
 * The dispatcher schema over the overflow tools: one bundle, their named
 * types merged. A tool whose named types clash with another's (same name,
 * different schema) is offered as JSON args described by its TypeScript
 * shape, and checked against its own schema when the call is decoded.
 */
function dispatcherSchema(overflow: readonly { name: string; description?: string; bound: Bound<unknown> }[]): { bound: Bound<{ tool: string; args: unknown }>; checkLater: Set<string> } {
  const env: Record<string, AnySchema> = {};
  const checkLater = new Set<string>();
  const cases = overflow.map((t) => {
    let clash = false;
    for (const [k, s] of t.bound.env) if (k in env && env[k] !== s) clash = true;
    if (!clash) for (const [k, s] of t.bound.env) env[k] = s;
    else checkLater.add(t.name);
    const schema: AnySchema = clash ? new AnyType().describe(`Arguments: ${t.bound.render(LENIENT).typescript()}`) : t.bound.root;
    return { name: t.name, ...(t.description ? { description: t.description } : {}), schema };
  });
  return { bound: new Bundle<{ tool: string; args: unknown }, []>(env, new DispatchType(cases)).bind(), checkLater };
}

/**
 * Fit every schema of one request to a model (see the top of this file).
 * Usually reached as `profileFor(model).request(items)`. Never throws unless
 * `failOnDegrade` is set.
 */
export function planRequest<const I extends readonly RequestItem[]>(target: ModelProfile, items: I, opts: RequestOptions = {}): RenderedRequest<I> {
  const limits = requestLimitsOf(target);
  const totals = limits.totals;
  let used: SchemaMeasure = ZERO_MEASURE;
  let strictTools = 0;
  const degradations: string[] = [];

  // Names: a second item with a taken name is renamed, not refused.
  const taken = new Set<string>();
  const names = items.map((item) => {
    const want = item.kind === 'output' ? item.name ?? 'output' : item.name;
    let n = want;
    for (let k = 2; taken.has(n); k++) n = `${want}_${k}`;
    taken.add(n);
    if (n !== want) degradations.push(`"${want}" is named twice; the second is "${n}"`);
    return n;
  });

  // Tool cap: the highest-priority tools stay tools; the rest go behind one dispatcher.
  const toolIdx = items.map((it, i) => (it.kind === 'tool' ? i : -1)).filter((i) => i >= 0);
  const byPriority = [...toolIdx].sort((x, y) => strictPriority(items[y]!.strict ?? 1) - strictPriority(items[x]!.strict ?? 1) || x - y);
  const overflow = new Set<number>();
  if (limits.maxTools !== undefined && toolIdx.length > limits.maxTools) {
    for (const i of byPriority.slice(Math.max(0, limits.maxTools - 1))) overflow.add(i);
  }
  let dispatcherName = opts.dispatcherName ?? 'run_tool';
  for (let k = 2; taken.has(dispatcherName); k++) dispatcherName = `${opts.dispatcherName ?? 'run_tool'}_${k}`;

  type Work = { schema: RequestSchema<unknown>; kind: 'tool' | 'output'; name: string; requestedName: string; strict: Strictness; delivery?: OutputItem['delivery']; slot: number };
  const work: Work[] = [];
  items.forEach((item, i) => {
    if (overflow.has(i)) return;
    work.push({
      schema: item.schema, kind: item.kind, name: names[i]!, requestedName: item.kind === 'output' ? item.name ?? 'output' : item.name,
      strict: item.strict ?? 1, ...(item.kind === 'output' && item.delivery ? { delivery: item.delivery } : {}), slot: i,
    });
  });
  let dispatchBound: Bound<{ tool: string; args: unknown }> | undefined;
  let checkLater = new Set<string>();
  if (overflow.size) {
    const list = [...overflow].sort((x, y) => x - y);
    const d = dispatcherSchema(list.map((i) => {
      const it = items[i] as ToolItem;
      return { name: names[i]!, ...(it.description ? { description: it.description } : {}), bound: boundOf(it.schema) };
    }));
    dispatchBound = d.bound;
    checkLater = d.checkLater;
    const best = Math.max(...list.map((i) => strictPriority(items[i]!.strict ?? 1)));
    work.push({ schema: dispatchBound as unknown as RequestSchema<unknown>, kind: 'tool', name: dispatcherName, requestedName: dispatcherName, strict: best === -Infinity ? false : best === Infinity ? 1 : best, slot: items.length });
    degradations.push(`${toolIdx.length} tools (limit ${limits.maxTools}): ${list.length} go through "${dispatcherName}"`);
  }

  const entries: RequestEntry<any>[] = new Array(items.length + (overflow.size ? 1 : 0));
  const order = work.map((w) => ({ w, p: strictPriority(w.strict) })).sort((x, y) => y.p - x.p || x.w.slot - y.w.slot);

  for (const { w, p } of order) {
    const { name } = w;
    const requested = w.strict;
    const bound = boundOf(w.schema);
    const offered = w.kind === 'tool' ? target.tool : target.output;
    // Tool parameters are an object for every provider.
    const base = w.kind === 'tool' ? variant(offered, { rootObject: true }) : offered;
    const loose = (b: Profile) => (b.strict ? variant(b.loose ?? LENIENT, { rootObject: b.rootObject }) : b);
    const reasons: string[] = [];
    const renamed: Adjustment[] = name !== w.requestedName ? [{ kind: 'renamed', from: w.requestedName }] : [];

    const make = (profile: Profile, strict: boolean, delivery: 'structured' | 'prompt', adj: Adjustment[]) => {
      const rendered = bound.render(profile);
      if (delivery === 'structured' && rendered.wrapped) adj.push({ kind: 'root-wrapped' });
      return new RequestEntry(name, w.kind, requested, base, profile, strict, delivery, [...renamed, ...adj], reasons, rendered, w.requestedName, undefined, bound);
    };

    // Prompt-text delivery: asked for, or the model has no structured output.
    const promptAsked = w.kind === 'output' && (w.delivery === 'prompt' || (target.outputDelivery === 'prompt' && w.delivery !== 'structured'));
    if (promptAsked) {
      const why = w.delivery === 'prompt' ? 'asked for prompt text' : 'the model has no structured output';
      if (w.delivery !== 'prompt') degradations.push(`"${name}": sent as prompt text (${why})`);
      entries[w.slot] = make(loose(base), false, 'prompt', [{ kind: 'prompt-text', reason: why }]);
      continue;
    }
    if (!base.strict || p <= 0) {
      const why = !base.strict ? 'the model has no strict mode for this' : requested === false ? 'strict: false' : 'strict not requested';
      // A family whose structured output is always strict (Claude) has no
      // non-strict structured output: a schema that isn't to be strict goes
      // as prompt text, unless structured delivery was insisted on.
      if (w.kind === 'output' && base.strict && base.alwaysStrictOutput && w.delivery !== 'structured') {
        entries[w.slot] = make(loose(base), false, 'prompt', [{ kind: 'prompt-text', reason: why }]);
      } else {
        entries[w.slot] = make(loose(base), false, 'structured', base.strict ? [{ kind: 'not-strict', reason: why }] : []);
      }
      continue;
    }

    const fits = (r: Rendered<unknown>, profile: Profile): string[] => {
      const m = r.measure;
      const out = overLimits(m, profile.limits, `"${name}"`);
      // A schema that alone breaks a request total can't fit any request.
      out.push(...overLimits(m, totals, `"${name}" alone`));
      if (out.length) return out;
      if (w.kind === 'tool' && limits.maxStrictTools !== undefined && strictTools >= limits.maxStrictTools) {
        out.push(`"${name}": no strict tool slots left (limit ${limits.maxStrictTools})`);
      }
      out.push(...overLimits(addMeasures(used, m), totals, `"${name}" with the request so far`));
      return out;
    };

    let chosen: { profile: Profile; adj: ProfileAdjustment; rendered: Rendered<unknown> } | undefined;
    const first = bound.render(base) as Rendered<unknown>;
    const firstProblems = fits(first, base);
    if (!firstProblems.length) chosen = { profile: base, adj: {}, rendered: first };
    else if (!firstProblems.some((x) => x.includes('no strict tool slots left'))) {
      reasons.push(...firstProblems);
      const wantNull = !!totals?.maxOptional && (used.optional + first.measure.optional > totals.maxOptional);
      for (const cand of candidates(base, first.measure, wantNull)) {
        const r = bound.render(cand.profile) as Rendered<unknown>;
        const pr = fits(r, cand.profile);
        if (!pr.length) { chosen = { ...cand, rendered: r }; break; }
      }
    } else reasons.push(...firstProblems);

    if (chosen) {
      used = addMeasures(used, chosen.rendered.measure);
      if (w.kind === 'tool') strictTools++;
      const adj = adjustmentsOf(chosen.adj);
      if (adj.length) degradations.push(`"${name}": ${adj.map((x) => x.kind).join(', ')} (${reasons.join('; ')})`);
      entries[w.slot] = make(chosen.profile, true, 'structured', adj);
      continue;
    }

    const why = reasons.join('; ');
    if (requested !== false) degradations.push(`"${name}": not strict (${why})`);
    if (w.kind === 'output' && base.alwaysStrictOutput && w.delivery !== 'structured') {
      entries[w.slot] = make(loose(base), false, 'prompt', [{ kind: 'prompt-text', reason: why }]);
    } else {
      entries[w.slot] = make(loose(base), false, 'structured', [{ kind: 'not-strict', reason: why }]);
    }
  }

  // The overflow tools: reached through the dispatcher, rendered with the dispatcher's profile
  // (their args are written exactly as inside it), each with its own entry for parse/encode.
  let dispatcher: RequestEntry<{ tool: string; args: unknown }> | undefined;
  if (overflow.size) {
    dispatcher = entries[items.length] as RequestEntry<{ tool: string; args: unknown }>;
    for (const i of overflow) {
      const it = items[i] as ToolItem;
      const bound = boundOf(it.schema);
      const reason = `${toolIdx.length} tools (limit ${limits.maxTools}); lower priority than the ${limits.maxTools! - 1} sent directly`;
      const renamed: Adjustment[] = names[i] !== it.name ? [{ kind: 'renamed', from: it.name }] : [];
      entries[i] = new RequestEntry(
        names[i]!, 'tool', it.strict ?? 1, variant(target.tool, { rootObject: true }), dispatcher.profile, dispatcher.strict, 'dispatched',
        [...renamed, { kind: 'dispatched', via: dispatcher.name, reason }], [reason], bound.render(dispatcher.profile), it.name, dispatcher.name, bound,
      );
    }
  }

  items.forEach((it, i) => (entries[i]!.errorFormat = mergeErrorFormats(opts.errorFormat, it.errorFormat)));
  if (dispatcher) dispatcher.errorFormat = mergeErrorFormats(opts.errorFormat);
  const req = new RenderedRequest<I>(target, entries, used, strictTools, limits, degradations, dispatcher, checkLater);
  if (opts.failOnDegrade) req.assertNoDegradation();
  return req;
}

export type { Bound };
