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
 * Every later use of that schema — the JSON sent, decoding the answer,
 * error paths, values encoded into instructions and examples — goes
 * through the entry's ONE `Rendered`, so nothing can drift from what the
 * model was shown.
 *
 * How a schema is fitted, in order (the first that fits wins):
 *
 * 1. the model's profile for its kind, as is;
 * 2. the same profile with absent optionals written as `null` (Anthropic:
 *    trades optional parameters for union types);
 * 3. with large enums widened to strings that list their values (fewer enum
 *    values and characters; still enforced on decode);
 * 4. with deep nesting written as JSON text (fewer levels and properties);
 * 5. not strict: the family's loose profile (a strict structured output on a
 *    family whose output is always strict goes as prompt text instead).
 *
 * Items are fitted in priority order (`strict: true` first, then higher
 * numbers; core's convention), so the most wanted schemas spend the budget
 * first. `strict: true` is never degraded to fit the BUDGET (only to fit a
 * per-schema limit no request could meet); an overflow is reported in
 * `problems` and thrown by `assertFits()`.
 */
import type { Bindable, Bound } from './module';
import { LENIENT, variant, type Profile, type ProfileAdjustment, type RequestLimits, type SchemaLimits, DEFAULT_JSON_INSTRUCTION } from './profile';
import type { CopyStats, EncodeTextOptions, Encoder, JsonSchema, ParseOptions, ParseResult, Rendered } from './render';
import { addMeasures, overLimits, ZERO_MEASURE, type SchemaMeasure } from './measure';
import { RequestLimitError } from './errors';
import { schemaHelpers, type HelperSet } from './template';
import type { ModelProfile } from './model';

/** A schema in a request: a bound bundle, or a ref-free schema / static bundle. */
export type RequestSchema<Out> = Bound<Out> | Bindable<Out, []>;

/** Strict request, as core spells it: `true` requires, `false` refuses, a number > 0 prefers (higher first). */
export type Strictness = boolean | number;

export interface ToolItem<N extends string = string, Out = unknown> {
  readonly kind: 'tool';
  readonly name: N;
  readonly schema: RequestSchema<Out>;
  /** Default `1` (prefer strict). */
  readonly strict?: Strictness;
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
}

export type RequestItem = ToolItem<string, any> | OutputItem<string, any>;

/** The name an item is looked up by. */
export type ItemName<I> = I extends { readonly kind: 'output' }
  ? (I extends { readonly name: infer N extends string } ? N : 'output')
  : I extends { readonly name: infer N extends string } ? N : never;
/** The code-shape output of an item's schema. */
export type ItemOut<I> = I extends { readonly schema: { readonly _out: infer O } } ? O : unknown;
/** The item named `N` (an item whose name is only known as `string` may be any of them). */
type ByName<I, N> = I extends unknown ? (ItemName<I> extends N ? I : string extends ItemName<I> ? I : never) : never;

/** One change made to the model's profile for this schema. */
export type Adjustment =
  | { readonly kind: 'optional-as-null' }
  | { readonly kind: 'enums-widened'; readonly maxEnumValues: number }
  | { readonly kind: 'depth-limited'; readonly maxDepth: number }
  | { readonly kind: 'root-wrapped' }
  | { readonly kind: 'not-strict'; readonly reason: string }
  | { readonly kind: 'prompt-text'; readonly reason: string };

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
    readonly delivery: 'structured' | 'prompt',
    readonly adjustments: readonly Adjustment[],
    /** The limits that ruled out the earlier choices (empty when the base fit). */
    readonly reasons: readonly string[],
    readonly rendered: Rendered<Out>,
  ) {}

  /** The JSON Schema to send; `undefined` when the schema goes as prompt text. */
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

  parse(wire: unknown, opts?: ParseOptions): ParseResult<Out> {
    return this.rendered.parse(wire, opts);
  }

  parseText(text: string, opts?: Omit<ParseOptions, 'inPlace'>): ParseResult<Out> {
    return this.rendered.parseText(text, opts);
  }

  parseOrThrow(wire: unknown, opts?: ParseOptions): Out {
    return this.rendered.parseOrThrow(wire, opts);
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

/** Every schema of one request, fitted together. */
export class RenderedRequest<I extends readonly RequestItem[] = readonly RequestItem[]> {
  private readonly byName = new Map<string, RequestEntry<any>>();

  constructor(
    readonly target: ModelProfile,
    /** In the order the items were given. */
    readonly entries: readonly RequestEntry<any>[],
    /** What the strict schemas add up to (the request totals). */
    readonly used: SchemaMeasure,
    /** How many tools went strict. */
    readonly strictTools: number,
    /** The request limits that applied. */
    readonly limits: RequestLimits,
    /** Limits the request still breaks (too many tools; hard-strict overflow). Empty when it fits. */
    readonly problems: readonly string[],
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

  get tools(): readonly RequestEntry<unknown>[] {
    return this.entries.filter((e) => e.kind === 'tool');
  }

  get output(): RequestEntry<unknown> | undefined {
    return this.entries.find((e) => e.kind === 'output');
  }

  /** Throw a `RequestLimitError` when `problems` is not empty. */
  assertFits(): this {
    if (this.problems.length) throw new RequestLimitError(this.problems);
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
 * Fit every schema of one request to a model (see the top of this file).
 * Usually reached as `profileFor(model).request(items)`.
 */
export function planRequest<const I extends readonly RequestItem[]>(target: ModelProfile, items: I): RenderedRequest<I> {
  const limits = requestLimitsOf(target);
  const totals = limits.totals;
  let used: SchemaMeasure = ZERO_MEASURE;
  let strictTools = 0;
  const problems: string[] = [];
  const entries: RequestEntry<any>[] = new Array(items.length);

  const order = items
    .map((item, i) => ({ item, i, p: strictPriority(item.strict ?? 1) }))
    .sort((x, y) => y.p - x.p || x.i - y.i);

  for (const { item, i, p } of order) {
    const name = item.kind === 'output' ? item.name ?? 'output' : item.name;
    const requested = item.strict ?? 1;
    const bound = boundOf(item.schema);
    const offered = item.kind === 'tool' ? target.tool : target.output;
    // Tool parameters are an object for every provider.
    const base = item.kind === 'tool' ? variant(offered, { rootObject: true }) : offered;
    const loose = (b: Profile) => (b.strict ? variant(b.loose ?? LENIENT, { rootObject: b.rootObject }) : b);
    const reasons: string[] = [];

    const make = (profile: Profile, strict: boolean, delivery: 'structured' | 'prompt', adj: Adjustment[]) => {
      const rendered = bound.render(profile);
      if (delivery === 'structured' && rendered.wrapped) adj.push({ kind: 'root-wrapped' });
      return new RequestEntry(name, item.kind, requested, base, profile, strict, delivery, adj, reasons, rendered);
    };

    // Prompt-text delivery: asked for, or the model has no structured output.
    const promptAsked = item.kind === 'output' && (item.delivery === 'prompt' || (target.outputDelivery === 'prompt' && item.delivery !== 'structured'));
    if (promptAsked) {
      const why = item.delivery === 'prompt' ? 'asked for prompt text' : 'the model has no structured output';
      entries[i] = make(loose(base), false, 'prompt', [{ kind: 'prompt-text', reason: why }]);
      continue;
    }
    if (!base.strict || p <= 0) {
      const why = !base.strict ? 'the model has no strict mode for this' : requested === false ? 'strict: false' : 'strict not requested';
      entries[i] = make(loose(base), false, 'structured', base.strict ? [{ kind: 'not-strict', reason: why }] : []);
      continue;
    }

    const hard = requested === true;
    const fits = (r: Rendered<unknown>, profile: Profile): string[] => {
      const m = r.measure;
      const out = overLimits(m, profile.limits, `"${name}"`);
      // A schema that alone breaks a request total can't fit any request.
      out.push(...overLimits(m, totals, `"${name}" alone`));
      if (out.length || hard) return out;
      if (item.kind === 'tool' && limits.maxStrictTools !== undefined && strictTools >= limits.maxStrictTools) {
        out.push(`"${name}": no strict tool slots left (limit ${limits.maxStrictTools})`);
      }
      out.push(...overLimits(addMeasures(used, m), totals, `"${name}" with the request so far`));
      return out;
    };

    let chosen: { profile: Profile; adj: ProfileAdjustment; rendered: Rendered<unknown> } | undefined;
    const first = bound.render(base) as Rendered<unknown>;
    const firstProblems = fits(first, base);
    if (!firstProblems.length) chosen = { profile: base, adj: {}, rendered: first };
    else {
      reasons.push(...firstProblems);
      const wantNull = !!totals?.maxOptional && (used.optional + first.measure.optional > totals.maxOptional);
      for (const cand of candidates(base, first.measure, wantNull)) {
        const r = bound.render(cand.profile) as Rendered<unknown>;
        const pr = fits(r, cand.profile);
        if (!pr.length) { chosen = { ...cand, rendered: r }; break; }
      }
    }

    if (chosen) {
      const m = chosen.rendered.measure;
      if (hard) {
        if (item.kind === 'tool' && limits.maxStrictTools !== undefined && strictTools >= limits.maxStrictTools) {
          problems.push(`"${name}" requires strict, but the ${limits.maxStrictTools} strict tool slots are taken`);
        }
        for (const pr of overLimits(addMeasures(used, m), totals, `"${name}" (strict: true) with the request so far`)) problems.push(pr);
      }
      used = addMeasures(used, m);
      if (item.kind === 'tool') strictTools++;
      entries[i] = make(chosen.profile, true, 'structured', adjustmentsOf(chosen.adj));
      continue;
    }

    const why = reasons.join('; ');
    if (item.kind === 'output' && base.alwaysStrictOutput && item.delivery !== 'structured') {
      entries[i] = make(loose(base), false, 'prompt', [{ kind: 'prompt-text', reason: why }]);
    } else {
      entries[i] = make(loose(base), false, 'structured', [{ kind: 'not-strict', reason: why }]);
    }
  }

  const toolCount = items.filter((x) => x.kind === 'tool').length;
  if (limits.maxTools !== undefined && toolCount > limits.maxTools) problems.unshift(`${toolCount} tools (limit ${limits.maxTools})`);
  const names = new Set<string>();
  for (const e of entries) {
    if (names.has(e.name)) problems.push(`two schemas are named "${e.name}"`);
    names.add(e.name);
  }
  return new RenderedRequest<I>(target, entries, used, strictTools, limits, problems);
}

export type { Bound };
