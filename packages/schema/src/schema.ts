/**
 * The schema classes. Each class:
 *
 * - carries its static types (`_out`, `_refs`, see `types.ts`),
 * - is immutable — `.describe()`, `.optional()` etc. return new instances,
 *   built once at module scope, never per call,
 * - owns its model-facing logic in `compile(c)`: what JSON it emits for a
 *   profile, how it validates + decodes the model's answer, how it encodes a
 *   code value into the model's shape, and what prose hint it adds.
 */
import type { Brand, JsonValue, Loose, RefMarker, Simplify } from './types';
import type { View, Profile } from './profile';
import { Cx, FAILED, Printer, newStats, readJsonText, type CopyStats, type Compiler, type JsonSchema, type Node, type PathSeg, type Rendered } from './render';
import { staticBundle, type Bound } from './module';

/** Description text: plain, or computed from the model-facing view so prose matches the wire shape. */
export type Text = string | ((view: View) => string);

/** Who a field is for. `people` fields are never shown to (or accepted from) a model. */
export type Audience = 'all' | 'people';

export interface Meta {
  readonly description?: Text;
  readonly title?: string;
  readonly examples?: readonly unknown[];
  readonly audience?: Audience;
  /** A narrower schema the MODEL sees in place of this one (e.g. an enum minus people-only members). */
  readonly forModels?: AnySchema;
}

export interface Check {
  readonly fn: (value: any) => boolean | string;
  readonly message?: string;
  /** Show the rule to the model in the description (default true when a message is given). */
  readonly visible?: boolean;
}

export type SchemaKind =
  | 'string' | 'number' | 'boolean' | 'null' | 'literal' | 'enum' | 'array' | 'tuple'
  | 'object' | 'record' | 'union' | 'optional' | 'nullable' | 'ref' | 'any' | 'codec'
  | 'intersection' | 'not' | 'conditional' | 'dependent' | 'never' | 'default';

/**
 * Any schema, structurally. An interface (not `Schema<any, any>`) so class
 * methods returning `this` never make one schema class "incompatible" with
 * the base during deep structural comparison.
 */
export interface AnySchema {
  readonly _out: unknown;
  readonly _refs: any;
  readonly kind: SchemaKind;
  readonly meta: Meta;
  readonly checks: readonly Check[];
  refNames(): ReadonlySet<string>;
  children(): readonly AnySchema[];
  compile(c: Compiler): Node;
  print(p: Printer): string;
  describe(text: Text): this;
  title(title: string): this;
  example(...values: any[]): this;
  refine(fn: (value: any) => boolean | string, message?: string, opts?: { visible?: boolean }): this;
}
/** `this` of a schema that uses no refs (so it can be bound without a chain). */
export interface RefFree {
  readonly _refs: never;
}
/** A schema whose code output is `Out`. */
export type SchemaOf<Out> = AnySchema & { readonly _out: Out };
export type OutOf<S extends AnySchema> = S['_out'];
export type RefsOf<S extends AnySchema> = S['_refs'];

const EMPTY: Meta = Object.freeze({});
const NONE: readonly Check[] = Object.freeze([]);

// ============================================================================
// Base
// ============================================================================

export abstract class Schema<Out = unknown, Refs extends string = never> {
  /** Code-shape output (phantom). */
  declare readonly _out: Out;
  /** Names of refs used below (phantom). */
  declare readonly _refs: Refs;
  abstract readonly kind: SchemaKind;
  readonly meta: Meta = EMPTY;
  readonly checks: readonly Check[] = NONE;
  private _refNames: ReadonlySet<string> | undefined;

  /** Direct children (for traversal / ref collection). */
  abstract children(): readonly AnySchema[];
  /** Build this schema's node for a profile. */
  abstract compile(c: Compiler): Node;
  /** TypeScript-like text of this schema. */
  abstract print(p: Printer): string;

  /** Runtime twin of `_refs`. */
  refNames(): ReadonlySet<string> {
    if (!this._refNames) {
      const s = new Set<string>();
      if (this instanceof RefType) s.add(this.name);
      for (const c of this.children()) for (const n of c.refNames()) s.add(n);
      if (this.meta.forModels) for (const n of this.meta.forModels.refNames()) s.add(n);
      this._refNames = s;
    }
    return this._refNames;
  }

  /** @internal A copy with metadata/checks/fields replaced (schemas are immutable). */
  with(patch: { meta?: Meta; checks?: readonly Check[]; [field: string]: unknown }): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this, patch, { _refNames: undefined });
    return c;
  }

  /** Description for the model (a string, or a function of the model-facing view). */
  describe(text: Text): this {
    return this.with({ meta: { ...this.meta, description: text } });
  }

  title(title: string): this {
    return this.with({ meta: { ...this.meta, title } });
  }

  /** Examples in the CODE shape; each profile renders them in its own wire shape. */
  example(...values: Loose<Out>[]): this {
    return this.with({ meta: { ...this.meta, examples: [...(this.meta.examples ?? []), ...values] } });
  }

  /**
   * A rule the type system can't say. Runs after decoding on the code value;
   * the error path is where the model wrote it. With a message the rule is
   * also shown to the model (pass `{ visible: false }` to keep it quiet).
   */
  refine(fn: (value: Loose<Out>) => boolean | string, message?: string, opts?: { visible?: boolean }): this {
    const check: Check = { fn, ...(message !== undefined ? { message } : {}), visible: opts?.visible ?? message !== undefined };
    return this.with({ checks: [...this.checks, check] });
  }

  /** Nominal brand (type only). */
  brand<B extends string>(): this & { readonly _out: Out & Brand<B> } {
    return this as this & { readonly _out: Out & Brand<B> };
  }

  /** Only for people (web forms, API callers); a model never sees or sends it. */
  forPeople(): this {
    return this.with({ meta: { ...this.meta, audience: 'people' } });
  }

  /** What the model sees instead of this schema; its output must fit this one's. */
  forModels<M extends SchemaOf<Out>>(model: M): this {
    return this.with({ meta: { ...this.meta, forModels: model } });
  }

  optional(): OptionalType<this> {
    return new OptionalType(this);
  }

  nullable(): NullableType<this> {
    return new NullableType(this);
  }

  /** May be left out; then decodes as `value` (zod's `.default`). Required in the code shape. */
  default(value: Exclude<Loose<Out>, undefined>): DefaultType<this> {
    return new DefaultType(this, value as never);
  }

  /** A ref-free schema is its own static bundle. */
  bind(this: RefFree): Bound<Out> {
    return staticBundle(this as unknown as Schema<Out, never>).bind();
  }

  /** Shorthand for `bind().render(profile)` (ref-free schemas only). */
  render(this: RefFree, profile: Profile): Rendered<Out> {
    return staticBundle(this as unknown as Schema<Out, never>).bind().render(profile);
  }

  /** Rules with messages, as model-facing text. */
  protected ruleHint(): string | undefined {
    const rules = this.checks.filter((c) => c.visible && c.message).map((c) => c.message!);
    return rules.length ? `Rules: ${rules.join(' ')}` : undefined;
  }

  /** Constraint words (what the dialect couldn't say as keywords) and the rules, as one hint. */
  protected hintOf(words: readonly string[]): string | undefined {
    const parts = [...words];
    const rules = this.ruleHint();
    if (rules) parts.push(rules);
    return parts.length ? parts.join(' ') : undefined;
  }
}

// ============================================================================
// Scalars
// ============================================================================

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
  /** Regex flags (gin's `flags`, e.g. `'i'`). JSON Schema has none: a flagged pattern is said in words, and checked. */
  readonly flags?: string;
}

/** Validators for the JSON Schema formats providers name; unknown formats are not checked. */
const FORMATS: Record<string, { test(v: string): boolean }> = {
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  date: /^\d{4}-\d{2}-\d{2}$/,
  time: /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?([Zz]|[+-]\d{2}:?\d{2})?$/,
  duration: /^-?P(?=\d|T\d)(\d+(\.\d+)?Y)?(\d+(\.\d+)?M)?(\d+(\.\d+)?W)?(\d+(\.\d+)?D)?(T(?=\d)(\d+(\.\d+)?H)?(\d+(\.\d+)?M)?(\d+(\.\d+)?S)?)?$/,
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  uri: /^[a-zA-Z][a-zA-Z\d+.-]*:\S*$/,
  hostname: /^(?=.{1,253}$)[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/,
  ipv4: /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/,
  ipv6: { test: (v) => v.includes(':') && /^[0-9a-fA-F:.]+$/.test(v) && validHost(`[${v}]`) },
};

/** The WHATWG URL parser is a complete IPv6 validator. */
function validHost(host: string): boolean {
  try {
    new URL(`http://${host}/`);
    return true;
  } catch {
    return false;
  }
}

/** A regex in the subset strict providers compile: no lookaround, backreferences, `\b`, `\p{…}` or large `{n,m}`. */
export function isBasicPattern(p: string): boolean {
  if (/\(\?<?[=!]|\\[bB]|\\[pP]\{|\\[1-9]|\\k</.test(p)) return false;
  for (const m of p.matchAll(/\{(\d+)(?:,(\d*))?\}/g)) if (Number(m[1]) > 100 || Number(m[2] || 0) > 100) return false;
  return true;
}

export class StringType extends Schema<string> {
  readonly kind = 'string' as const;
  constructor(readonly options: StringOptions = {}) { super(); }
  children() { return []; }
  min(n: number): this { return this.opts({ minLength: n }); }
  max(n: number): this { return this.opts({ maxLength: n }); }
  pattern(re: RegExp | string, flags?: string): this {
    const f = typeof re === 'string' ? flags : flags ?? (re.flags || undefined);
    return this.opts({ pattern: typeof re === 'string' ? re : re.source, ...(f ? { flags: f } : {}) });
  }
  format(f: string): this { return this.opts({ format: f }); }
  private opts(o: StringOptions): this {
    return this.with({ options: { ...this.options, ...o } });
  }
  print() { return 'string'; }
  compile(c: Compiler): Node {
    const o = this.options;
    const p = c.profile;
    const re = o.pattern !== undefined ? new RegExp(o.pattern, o.flags?.replace(/[gy]/g, '')) : undefined;
    const shown = `/${o.pattern}/${o.flags ?? ''}`;
    const fmt = o.format !== undefined ? FORMATS[o.format] : undefined;
    const words: string[] = [];
    return c.node({
      hint: () => this.hintOf(words),
      emit: () => {
        const j: JsonSchema = { type: 'string' };
        keyword(j, words, 'minLength', o.minLength, p.constraints.length, `At least ${o.minLength} characters.`);
        keyword(j, words, 'maxLength', o.maxLength, p.constraints.length, `At most ${o.maxLength} characters.`);
        const patternOk = !o.flags && (p.constraints.pattern === 'full' || (p.constraints.pattern === 'basic' && o.pattern !== undefined && isBasicPattern(o.pattern)));
        keyword(j, words, 'pattern', o.pattern, patternOk, `Must match ${shown}.`);
        keyword(j, words, 'format', o.format, p.formats === 'all' || (o.format !== undefined && p.formats.has(o.format)), `Format: ${o.format}.`);
        return j;
      },
      run: (v, cx) => {
        if (typeof v !== 'string') return fail(cx, v, `Expected a string, got ${kind(v)}.`);
        if (o.minLength !== undefined && v.length < o.minLength) cx.fail(`Must be at least ${o.minLength} characters.`);
        if (o.maxLength !== undefined && v.length > o.maxLength) cx.fail(`Must be at most ${o.maxLength} characters.`);
        if (re && !re.test(v)) cx.fail(`Must match ${shown}.`);
        if (fmt && !fmt.test(v)) cx.fail(`Must be a valid ${o.format}.`);
        return v;
      },
      encode: (v) => v,
    });
  }
}

export interface NumberOptions {
  readonly int?: boolean;
  readonly minimum?: number;
  readonly maximum?: number;
}

export class NumberType extends Schema<number> {
  readonly kind = 'number' as const;
  constructor(readonly options: NumberOptions = {}) { super(); }
  children() { return []; }
  min(n: number): this { return this.opts({ minimum: n }); }
  max(n: number): this { return this.opts({ maximum: n }); }
  int(): this { return this.opts({ int: true }); }
  private opts(o: NumberOptions): this {
    return this.with({ options: { ...this.options, ...o } });
  }
  print() { return 'number'; }
  compile(c: Compiler): Node {
    const o = this.options;
    const range = c.profile.constraints.range;
    const words: string[] = [];
    return c.node({
      hint: () => this.hintOf(words),
      emit: () => {
        const j: JsonSchema = { type: o.int ? 'integer' : 'number' };
        keyword(j, words, 'minimum', o.minimum, range, `At least ${o.minimum}.`);
        keyword(j, words, 'maximum', o.maximum, range, `At most ${o.maximum}.`);
        return j;
      },
      run: (v, cx) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return fail(cx, v, `Expected a number, got ${kind(v)}.`);
        if (o.int && !Number.isInteger(v)) cx.fail('Expected a whole number.');
        if (o.minimum !== undefined && v < o.minimum) cx.fail(`Must be at least ${o.minimum}.`);
        if (o.maximum !== undefined && v > o.maximum) cx.fail(`Must be at most ${o.maximum}.`);
        return v;
      },
      encode: (v) => v,
    });
  }
}

export class BooleanType extends Schema<boolean> {
  readonly kind = 'boolean' as const;
  children() { return []; }
  print() { return 'boolean'; }
  compile(c: Compiler): Node {
    return c.node({
      hint: () => this.ruleHint(),
      emit: () => ({ type: 'boolean' }),
      run: (v, cx) => (typeof v === 'boolean' ? v : fail(cx, v, `Expected true or false, got ${kind(v)}.`)),
      encode: (v) => v,
    });
  }
}

export class NullType extends Schema<null> {
  readonly kind = 'null' as const;
  children() { return []; }
  print() { return 'null'; }
  compile(c: Compiler): Node {
    return c.node({
      emit: () => ({ type: 'null' }),
      run: (v, cx) => (v === null ? v : fail(cx, v, `Expected null, got ${kind(v)}.`)),
      encode: (v) => v,
    });
  }
}

export type LiteralValue = string | number | boolean | null;

export class LiteralType<V extends LiteralValue> extends Schema<V> {
  readonly kind = 'literal' as const;
  constructor(readonly value: V) { super(); }
  children() { return []; }
  print() { return JSON.stringify(this.value); }
  compile(c: Compiler): Node {
    const v0 = this.value;
    return c.node({
      hint: () => this.ruleHint(),
      emit: () => (v0 === null ? { type: 'null' } : { type: jsonType(v0), enum: [v0] }),
      run: (v, cx) => (v === v0 ? v : fail(cx, v, `Expected ${JSON.stringify(v0)}.`)),
      encode: (v) => v,
    });
  }
}

export class EnumType<V extends readonly [string, ...string[]]> extends Schema<V[number]> {
  readonly kind = 'enum' as const;
  constructor(readonly values: V) { super(); }
  children() { return []; }
  print() { return this.values.length ? this.values.map((v) => JSON.stringify(v)).join(' | ') : 'never'; }
  compile(c: Compiler): Node {
    const values = this.values;
    // An enum built from an empty runtime list (no functions selected, no
    // permitted types) admits nothing: it is `never`, not an empty `enum`
    // (which providers reject).
    if (!values.length) return neverNode(c, () => this.ruleHint());
    const set = new Set<string>(values);
    const cap = c.profile.maxEnumValues;
    const widened = cap !== undefined && values.length > cap;
    return c.node({
      // Over the dialect's cap the enum is WIDENED (never truncated): every
      // value moves into the description, and decoding still enforces it.
      hint: () => this.hintOf(widened ? [`One of: ${values.join(', ')}.`] : []),
      emit: () => (widened ? { type: 'string' } : { type: 'string', enum: [...values] }),
      run: (v, cx) => {
        if (typeof v !== 'string' || !set.has(v)) return fail(cx, v, `Expected one of: ${values.join(', ')}.`);
        return v;
      },
      encode: (v) => v,
    });
  }
}

/** Any JSON value (`a.unknown()` types it `unknown`, `a.json()` types it `JsonValue`). */
export class AnyType<Out = unknown> extends Schema<Out> {
  readonly kind = 'any' as const;
  children() { return []; }
  print() { return 'any JSON value'; }
  compile(c: Compiler): Node {
    const mode = c.profile.any;
    if (mode === 'empty' || mode === 'flat') {
      return c.node({
        hint: () => this.ruleHint(),
        emit: () => (mode === 'empty' ? {} : { anyOf: FLAT_ANY.map((b) => ({ ...b })) }),
        run: (v, cx) => (v === undefined ? fail(cx, v, 'Required.') : v),
        encode: (v) => v,
      });
    }
    // No spelling for "any value" in this dialect: JSON text, parsed on decode.
    return markJsonText(c.node({
      own: true,
      hint: () => this.hintOf(['Write the value as JSON text.']),
      emit: () => ({ type: 'string' }),
      run: (v, cx) => {
        const out = readJsonText(v, cx);
        return out === FAILED ? v : out;
      },
      encode: (v) => JSON.stringify(v),
    }));
  }
}

function markJsonText(n: Node): Node {
  n.jsonText = true;
  return n;
}

/** xAI's spelling of "any JSON value" (it rejects recursive `$defs`; objects must say they are open). */
const FLAT_ANY: readonly JsonSchema[] = Object.freeze([
  { type: 'string' }, { type: 'number' }, { type: 'boolean' }, { type: 'null' },
  { type: 'array' }, { type: 'object', additionalProperties: true },
]);

// ============================================================================
// Containers
// ============================================================================

export class ArrayType<E extends AnySchema> extends Schema<OutOf<E>[], RefsOf<E>> {
  readonly kind = 'array' as const;
  constructor(readonly element: E, readonly options: { readonly minItems?: number; readonly maxItems?: number } = {}) { super(); }
  children() { return [this.element]; }
  min(n: number): this { return this.with({ options: { ...this.options, minItems: n } }); }
  max(n: number): this { return this.with({ options: { ...this.options, maxItems: n } }); }
  print(p: Printer) {
    const inner = p.print(this.element);
    return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
  }
  compile(c: Compiler): Node {
    // A list of `never` can only be empty (query: `joins` when no type has a relation).
    const o = isNever(this.element, c.env) ? { ...this.options, maxItems: 0 } : this.options;
    const el = (o.minItems ?? 0) > 0 ? c.compile(this.element) : c.guarded(this.element);
    const items = c.profile.constraints.items;
    const words: string[] = [];
    return c.node({
      deps: [el],
      hint: () => this.hintOf(words),
      emit: () => {
        const j: JsonSchema = { type: 'array', items: el.json() };
        keyword(j, words, 'minItems', o.minItems, items === 'all' || (items === 'min-0-1' && (o.minItems ?? 0) <= 1), `At least ${o.minItems} items.`);
        keyword(j, words, 'maxItems', o.maxItems, items === 'all', `At most ${o.maxItems} items.`);
        return j;
      },
      run: (v0, cx) => {
        const v = repairJson(v0, cx, 'array');
        if (!Array.isArray(v)) return fail(cx, v, `Expected a list, got ${kind(v)}.`);
        if (o.minItems !== undefined && v.length < o.minItems) cx.fail(`Must have at least ${o.minItems} items.`);
        if (o.maxItems !== undefined && v.length > o.maxItems) cx.fail(`Must have at most ${o.maxItems} items.`);
        let out = v;
        for (let i = 0; i < v.length; i++) {
          cx.enter(i);
          const r = el.run(v[i], cx);
          cx.leave();
          if (r !== v[i] && !cx.dry) out = writeIndex(out, v, i, r, cx);
        }
        return out;
      },
      encode: (v, st) => encodeItems(v as unknown[], (x) => el.encode(x, st), st),
      child: () => el,
    });
  }
}

type TupleOut<T extends readonly AnySchema[]> = { -readonly [K in keyof T]: T[K] extends AnySchema ? OutOf<T[K]> : never };

export class TupleType<T extends readonly [AnySchema, ...AnySchema[]]> extends Schema<TupleOut<T>, RefsOf<T[number]>> {
  readonly kind = 'tuple' as const;
  constructor(readonly items: T) { super(); }
  children() { return this.items; }
  print(p: Printer) { return `[${this.items.map((i) => p.print(i)).join(', ')}]`; }
  compile(c: Compiler): Node {
    const nodes = this.items.map((i) => c.compile(i));
    const mode = c.profile.tuples;
    const n = nodes.length;
    const runItems = (arr: unknown[], cx: Cx, path: (i: number) => string | number): unknown[] => {
      let out = arr;
      for (let i = 0; i < n; i++) {
        cx.enter(path(i), i);
        const r = nodes[i]!.run(arr[i], cx);
        cx.leave();
        if (r !== arr[i] && !cx.dry) out = writeIndex(out, arr, i, r, cx);
      }
      return out;
    };
    return c.node({
      own: mode === 'object',
      deps: nodes,
      hint: () => this.hintOf(
        mode === 'object' ? [`Positions are written as keys "0".."${n - 1}".`]
        : mode === 'array' ? [`Exactly ${n} items, in order: ${this.items.map((i) => i.print(new Printer(c.env))).join(', ')}.`]
        : [],
      ),
      emit: () => {
        if (mode === 'object') {
          const properties: Record<string, JsonSchema> = {};
          nodes.forEach((x, i) => (properties[String(i)] = x.json()));
          return c.object(properties, Object.keys(properties));
        }
        if (mode === 'prefixItems') return { type: 'array', prefixItems: nodes.map((x) => x.json()), minItems: n, maxItems: n };
        const j: JsonSchema = { type: 'array', items: { anyOf: nodes.map((x) => x.json()) } };
        return j;
      },
      run: (v0, cx) => {
        if (mode === 'object') {
          const v = repairJson(v0, cx, 'object');
          if (!isObject(v)) return fail(cx, v, 'Expected an object with keys "0".."' + (n - 1) + '".');
          // Shape change: one new array; the item values are moved, not copied.
          const arr = new Array(n);
          for (let i = 0; i < n; i++) arr[i] = (v as Record<string, unknown>)[String(i)];
          if (!cx.dry) cx.stats.arrays++;
          const out = runItems(arr, cx, (i) => String(i));
          return cx.dry ? v : out;
        }
        const v = repairJson(v0, cx, 'array');
        if (!Array.isArray(v)) return fail(cx, v, `Expected a list of ${n} items.`);
        if (v.length !== n) cx.fail(`Expected exactly ${n} items.`);
        return runItems(v, cx, (i) => i);
      },
      encode: (v, st) => {
        const arr = v as unknown[];
        if (mode !== 'object') return encodeItems(arr, (x, i) => nodes[i]!.encode(x, st), st);
        const o: Record<string, unknown> = {};
        st.objects++;
        arr.forEach((x, i) => (o[String(i)] = nodes[i]!.encode(x, st)));
        return o;
      },
      child: (seg) => nodes[Number(seg)],
    });
  }
}

export type Shape = { readonly [key: string]: AnySchema };

type IsOptional<S> = S extends OptionalType<any> ? true : false;
type OptionalKeys<S extends Shape> = { [K in keyof S]: IsOptional<S[K]> extends true ? K : never }[keyof S];
type RequiredKeys<S extends Shape> = Exclude<keyof S, OptionalKeys<S>>;

/** Object output: required keys, then `?:` keys (absent — never `undefined` — after decoding). */
export type ObjectOut<S extends Shape> = Simplify<
  { -readonly [K in RequiredKeys<S>]: OutOf<S[K]> } & { -readonly [K in OptionalKeys<S>]?: Exclude<OutOf<S[K]>, undefined> }
>;
export type ShapeRefs<S extends Shape> = { [K in keyof S]: RefsOf<S[K]> }[keyof S] & string;
/** An object with extra keys (`rest`) adds an index signature. */
export type ObjectRestOut<S extends Shape, R> = [R] extends [AnySchema] ? ObjectOut<S> & { [key: string]: OutOf<R> } : ObjectOut<S>;
type RestRefs<R> = R extends AnySchema ? RefsOf<R> & string : never;

/** Extra keys of an object beyond its shape: by key pattern, then any other key. */
export interface ObjectExtras {
  /** The schema of any other key (`additionalProperties: schema`). */
  readonly rest?: AnySchema;
  /** Schemas of keys matching a pattern (`patternProperties`), tried before `rest`. */
  readonly patterns?: readonly { readonly pattern: string; readonly schema: AnySchema }[];
}

export class ObjectType<S extends Shape, R extends AnySchema | undefined = undefined> extends Schema<ObjectRestOut<S, R>, ShapeRefs<S> | RestRefs<R>> {
  readonly kind = 'object' as const;
  constructor(readonly shape: S, readonly closed = false, readonly extras: ObjectExtras = {}) { super(); }
  children(): AnySchema[] {
    const out = Object.values(this.shape);
    if (this.extras.rest) out.push(this.extras.rest);
    for (const p of this.extras.patterns ?? []) out.push(p.schema);
    return out;
  }
  /** Unknown keys are an error (default: left in place untouched — no copy to strip them). */
  strict(): this {
    return this.with({ closed: true });
  }
  extend<S2 extends Shape>(more: S2): ObjectType<Simplify<Omit<S, keyof S2> & S2>, R> {
    return new ObjectType({ ...this.shape, ...more } as Simplify<Omit<S, keyof S2> & S2>, this.closed, this.extras);
  }
  /** Keys beyond the shape, each a `V` (zod's `catchall`). */
  rest<V extends AnySchema>(value: V): ObjectType<S, V> {
    return new ObjectType(this.shape, this.closed, { ...this.extras, rest: value });
  }
  /** Keys matching a pattern (`patternProperties`); their values are typed `unknown` in the code shape. */
  patterns(patterns: { readonly [pattern: string]: AnySchema }): ObjectType<S, AnyType<unknown>> {
    const list = Object.entries(patterns).map(([pattern, schema]) => ({ pattern, schema }));
    return new ObjectType(this.shape, this.closed, { ...this.extras, patterns: [...(this.extras.patterns ?? []), ...list] }) as unknown as ObjectType<S, AnyType<unknown>>;
  }
  /**
   * A field whose schema depends on a sibling's DECODED value — e.g. a value
   * typed by the `type` the model wrote next to it. The model sees `base`
   * (default any JSON); decoding checks the value against `schemaFor(sibling)`.
   */
  dependent<K extends string, On extends keyof S & string, B extends AnySchema = AnyType<unknown>>(
    key: K,
    on: On,
    schemaFor: (sibling: Loose<OutOf<S[On]>>) => AnySchema | undefined,
    base?: B,
  ): ObjectType<Simplify<Omit<S, K> & { [P in K]: DependentType<OutOf<B>> }>, R> {
    const dep = new DependentType<OutOf<B>>(on, schemaFor as (sibling: unknown) => AnySchema | undefined, (base ?? new AnyType()) as AnySchema);
    return new ObjectType({ ...this.shape, [key]: dep } as Simplify<Omit<S, K> & { [P in K]: DependentType<OutOf<B>> }>, this.closed, this.extras);
  }
  print(p: Printer) {
    const parts = Object.entries(this.shape).map(([k, s]) => {
      const opt = s instanceof OptionalType || s instanceof DefaultType;
      return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${opt ? '?' : ''}: ${p.print(opt ? (s as OptionalType<AnySchema>).inner : s)}`;
    });
    const extra = this.extraValue();
    if (extra) parts.push(`[key: string]: ${p.print(extra)}`);
    return `{ ${parts.join('; ')} }`;
  }

  private _extraValue: AnySchema | null | undefined;
  /** The schema of an extra key's value as the model sees it (rest and patterns together). */
  private extraValue(): AnySchema | undefined {
    if (this._extraValue === undefined) {
      const opts = [...(this.extras.patterns ?? []).map((p) => p.schema), ...(this.extras.rest ? [this.extras.rest] : [])];
      this._extraValue = opts.length === 0 ? null : opts.length === 1 ? opts[0]! : new UnionType(opts as [AnySchema, ...AnySchema[]]);
    }
    return this._extraValue ?? undefined;
  }

  compile(c: Compiler): Node {
    const p = c.profile;
    const nullMode = p.optional === 'null';
    const forModel = p.audience !== 'people';
    type Field = { key: string; optional: boolean; node: Node; nullable: boolean; dep?: DependentType<unknown>; dflt?: DefaultType<AnySchema> };
    const fields: Field[] = [];
    const hidden = new Set<string>();
    for (const [key, s] of Object.entries(this.shape)) {
      if (forModel && s.meta.audience === 'people') {
        hidden.add(key);
        continue;
      }
      const dflt = s instanceof DefaultType ? (s as DefaultType<AnySchema>) : undefined;
      const optional = s instanceof OptionalType || !!dflt;
      const inner = s instanceof OptionalType ? (s as OptionalType<AnySchema>).inner : dflt ? dflt.inner : s;
      // An optional field that admits nothing is not offered to the model (and refused if sent).
      if (optional && isNever(inner, c.env)) {
        hidden.add(key);
        continue;
      }
      const node = optional ? c.guarded(inner, s) : c.compile(inner);
      fields.push({ key, optional, node, nullable: inner instanceof NullableType, ...(inner instanceof DependentType ? { dep: inner } : {}), ...(dflt ? { dflt } : {}) });
    }
    const plain = fields.filter((f) => !f.dep);
    const deps = fields.filter((f) => f.dep);
    const known = new Set(Object.keys(this.shape));

    // Extra keys: open where the dialect takes a schema-valued
    // additionalProperties, else a pairs list under one extra field.
    const extra = this.extraValue();
    const patterns = (this.extras.patterns ?? []).map((x) => ({ re: new RegExp(x.pattern), pattern: x.pattern, node: c.guarded(x.schema) }));
    const restNode = this.extras.rest ? c.guarded(this.extras.rest) : undefined;
    const extraMode = !extra ? 'none' : p.records === 'pairs' ? 'pairs' : p.patternProperties ? 'keywords' : 'open';
    const extraKey = extraMode === 'pairs' ? (known.has('extra') ? '_extra' : 'extra') : '';
    const extraNode = extra && extraMode !== 'keywords' ? c.guarded(extra) : undefined;
    const nodeForKey = (k: string): Node | undefined => patterns.find((x) => x.re.test(k))?.node ?? restNode;

    return c.node({
      own: (nullMode && fields.some((f) => f.optional && !f.nullable)) || hidden.size > 0 || extraMode === 'pairs' || fields.some((f) => f.dflt),
      deps: [...fields.map((f) => f.node), ...patterns.map((x) => x.node), ...(restNode ? [restNode] : []), ...(extraNode ? [extraNode] : [])],
      hint: () => this.hintOf(
        extraMode === 'pairs' ? [`Other keys go in "${extraKey}" as a list of {key, value} entries.`]
        : extraMode === 'open' && patterns.length ? [`Other keys: ${patterns.map((x) => `keys matching /${x.pattern}/ hold ${x.node.schema?.print(new Printer(c.env)) ?? 'a value'}`).join('; ')}${restNode ? '; any other key holds the rest' : ''}.`]
        : [],
      ),
      emit: () => {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        for (const f of fields) {
          let j = f.node.json();
          if (f.dep) j = { ...j, description: [j.description, `Its type is given by "${f.dep.on}".`].filter(Boolean).join('\n') };
          if (f.dflt) j = { ...j, description: [j.description, `Default when left out: ${JSON.stringify(f.node.encode(f.dflt.value))}.`].filter(Boolean).join('\n') };
          if (f.optional && nullMode) {
            j = c.nullable(j);
            j.description = [j.description, 'Write null to leave it out.'].filter(Boolean).join('\n');
          }
          properties[f.key] = j;
          if (!f.optional || nullMode) required.push(f.key);
        }
        if (extraMode === 'pairs') {
          properties[extraKey] = {
            type: 'array',
            items: c.object({ key: { type: 'string' }, value: extraNode!.json() }, ['key', 'value'], true),
          };
          if (nullMode) required.push(extraKey);
        }
        const j = c.object(properties, required, this.closed || p.closedObjects);
        if (extraMode === 'keywords') {
          if (patterns.length) j.patternProperties = Object.fromEntries(patterns.map((x) => [x.pattern, x.node.json()]));
          if (restNode) j.additionalProperties = restNode.json();
        } else if (extraMode === 'open') {
          j.additionalProperties = extraNode!.json();
        }
        return j;
      },
      run: (v0, cx) => {
        const v = repairJson(v0, cx, 'object');
        if (!isObject(v)) return fail(cx, v, `Expected an object, got ${kind(v)}.`);
        const obj = v as Record<string, unknown>;
        let out = obj;
        for (const f of plain) {
          const has = Object.prototype.hasOwnProperty.call(obj, f.key);
          const val = has ? obj[f.key] : undefined;
          if (val === undefined) {
            if (f.dflt) { if (!cx.dry) out = writeKey(out, obj, f.key, f.dflt.fresh(cx.stats), cx); }
            else if (!f.optional) { cx.enter(f.key); cx.fail('Required.'); cx.leave(); }
            continue;
          }
          if (val === null && f.optional && nullMode && !f.nullable) {
            // Strict null means ABSENT in the code shape: the key goes, not `undefined`
            // (or the default goes in).
            if (!cx.dry) out = f.dflt ? writeKey(out, obj, f.key, f.dflt.fresh(cx.stats), cx) : deleteKey(out, obj, f.key, cx);
            continue;
          }
          cx.enter(f.key);
          const r = f.node.run(val, cx);
          cx.leave();
          if (r !== val && !cx.dry) out = writeKey(out, obj, f.key, r, cx);
        }
        // Dependent fields last: their schema comes from a sibling's decoded value.
        for (const f of deps) {
          const val = obj[f.key];
          if (val === undefined || (val === null && f.optional && nullMode)) {
            if (val === null && !cx.dry) out = deleteKey(out, obj, f.key, cx);
            else if (!f.optional) { cx.enter(f.key); cx.fail('Required.'); cx.leave(); }
            continue;
          }
          cx.enter(f.key);
          const before = cx.errors.length;
          let r = f.node.run(val, cx);
          if (cx.errors.length === before) {
            const s = f.dep!.schemaFor(out[f.dep!.on]);
            if (s) r = c.lenient().nodeFor(s).run(r, cx);
          }
          cx.leave();
          if (r !== val && !cx.dry) out = writeKey(out, obj, f.key, r, cx);
        }
        for (const key of hidden) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) { cx.enter(key); cx.fail('Not allowed.'); cx.leave(); }
        }
        if (extraMode === 'pairs') {
          const list = obj[extraKey];
          if (list !== undefined && list !== null) {
            cx.enter(extraKey, null);
            const entries = repairJson(list, cx, 'array');
            if (!Array.isArray(entries)) fail(cx, entries, 'Expected a list of {key, value} entries.');
            else {
              if (!cx.dry) out = deleteKey(out, obj, extraKey, cx);
              for (let i = 0; i < entries.length; i++) {
                const e = entries[i] as { key?: unknown; value?: unknown };
                cx.enter(i, null);
                if (!isObject(e) || typeof e.key !== 'string') { cx.fail('Expected a {key, value} entry with a string key.'); cx.leave(false); continue; }
                const k = e.key;
                if (known.has(k) || Object.prototype.hasOwnProperty.call(out, k)) { cx.enter('key', null); cx.fail(`Duplicate key "${k}".`); cx.leave(false); cx.leave(false); continue; }
                const node = nodeForKey(k);
                cx.enter('value', k);
                const r = node ? node.run(e.value, cx) : this.closed ? fail(cx, e.value, `Key "${k}" is not allowed.`) : e.value;
                cx.leave();
                if (!cx.dry) out = writeKey(out, obj, k, r, cx);
                cx.leave(false);
              }
            }
            cx.leave(false);
          } else if (extraKey && list === null && !cx.dry) out = deleteKey(out, obj, extraKey, cx);
        } else {
          for (const key of Object.keys(obj)) {
            if (known.has(key)) continue;
            const node = extra ? nodeForKey(key) : undefined;
            if (node) {
              cx.enter(key);
              const r = node.run(obj[key], cx);
              cx.leave();
              if (r !== obj[key] && !cx.dry) out = writeKey(out, obj, key, r, cx);
            } else if (this.closed) {
              cx.enter(key); cx.fail(`Unknown field "${key}".`); cx.leave();
            }
          }
        }
        return out;
      },
      encode: (v, st) => {
        const obj = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        st.objects++;
        const pairs: { key: string; value: unknown }[] = [];
        for (const k of Object.keys(obj)) {
          if (hidden.has(k)) continue;
          if (known.has(k)) continue;
          const node = nodeForKey(k);
          const enc = node ? node.encode(obj[k], st) : obj[k];
          if (extraMode === 'pairs') pairs.push({ key: k, value: enc });
          else out[k] = enc;
        }
        for (const f of fields) {
          const val = obj[f.key];
          if (val === undefined) {
            if (f.optional && nullMode) out[f.key] = null;
            continue;
          }
          out[f.key] = f.node.encode(val, st);
        }
        if (extraMode === 'pairs') {
          if (pairs.length || nullMode) {
            st.arrays++;
            st.objects += pairs.length;
            out[extraKey] = pairs;
          }
        }
        return out;
      },
      child: (seg) => fields.find((f) => f.key === seg)?.node ?? (typeof seg === 'string' ? nodeForKey(seg) : undefined),
    });
  }
}

export class RecordType<V extends AnySchema, K extends string = string> extends Schema<
  string extends K ? Record<string, OutOf<V>> : Partial<Record<K, OutOf<V>>>,
  RefsOf<V>
> {
  readonly kind = 'record' as const;
  constructor(readonly value: V, readonly key?: StringType | EnumType<any>) { super(); }
  children() { return this.key ? [this.key, this.value] : [this.value]; }
  print(p: Printer) { return `{ [key: ${this.key ? p.print(this.key) : 'string'}]: ${p.print(this.value)} }`; }
  compile(c: Compiler): Node {
    const val = c.guarded(this.value);
    const key = c.compile(this.key ?? STRING);
    const pairs = c.profile.records === 'pairs';
    return c.node({
      own: pairs,
      deps: [val, key],
      // The one place that says how a record looks to THIS model. Prose that
      // must mention it uses `view.recordWord` (see `Text`).
      hint: (view) => this.hintOf(pairs ? [`A map written as ${view.recordWord}; each key at most once.`] : []),
      emit: () => {
        if (pairs) {
          return { type: 'array', items: c.object({ key: key.json(), value: val.json() }, ['key', 'value'], true) };
        }
        const j: JsonSchema = { type: 'object', additionalProperties: val.json() };
        // A plain string key gets no `propertyNames` (DeepInfra/Cloudflare reject the keyword, measured 2026-11-04).
        if (this.key && !c.profile.closedObjects && !(this.key instanceof StringType && !Object.keys(this.key.options).length)) j.propertyNames = key.json();
        return j;
      },
      run: (v0, cx) => {
        if (pairs) {
          const v = repairJson(v0, cx, 'array');
          if (!Array.isArray(v)) return fail(cx, v, `Expected a list of {key, value} entries, got ${kind(v)}.`);
          // Shape change: ONE new object per record. Values are moved by reference.
          const rec: Record<string, unknown> = {};
          if (!cx.dry) cx.stats.objects++;
          for (let i = 0; i < v.length; i++) {
            const e = v[i];
            cx.enter(i, null);
            if (!isObject(e)) { fail(cx, e, 'Expected a {key, value} entry.'); cx.leave(false); continue; }
            const k = (e as { key?: unknown }).key;
            cx.enter('key', null);
            key.run(k, cx);
            cx.leave(false);
            if (typeof k === 'string') {
              if (Object.prototype.hasOwnProperty.call(rec, k)) { cx.enter('key', null); cx.fail(`Duplicate key "${k}".`); cx.leave(false); }
              cx.enter('value', k);
              rec[k] = val.run((e as { value?: unknown }).value, cx);
              cx.leave();
            }
            cx.leave(false);
          }
          return cx.dry ? v : rec;
        }
        const v = repairJson(v0, cx, 'object');
        if (!isObject(v)) return fail(cx, v, `Expected an object, got ${kind(v)}.`);
        const obj = v as Record<string, unknown>;
        let out = obj;
        for (const k of Object.keys(obj)) {
          if (this.key) { cx.enter(k); key.run(k, cx); cx.leave(); }
          cx.enter(k);
          const r = val.run(obj[k], cx);
          cx.leave();
          if (r !== obj[k] && !cx.dry) out = writeKey(out, obj, k, r, cx);
        }
        return out;
      },
      encode: (v, st) => {
        const obj = v as Record<string, unknown>;
        if (pairs) {
          const keys = Object.keys(obj);
          st.arrays++;
          st.objects += keys.length;
          return keys.map((k) => ({ key: k, value: val.encode(obj[k], st) }));
        }
        let out = obj;
        for (const k of Object.keys(obj)) {
          const e = val.encode(obj[k], st);
          if (e !== obj[k]) {
            if (out === obj) { out = { ...obj }; st.objects++; }
            out[k] = e;
          }
        }
        return out;
      },
      child: () => val,
    });
  }
}

const STRING = new StringType();

// ============================================================================
// Unions
// ============================================================================

export class UnionType<O extends readonly [AnySchema, ...AnySchema[]]> extends Schema<OutOf<O[number]>, RefsOf<O[number]>> {
  readonly kind = 'union' as const;
  constructor(readonly options: O, readonly tag?: string) { super(); }
  children() { return this.options; }
  print(p: Printer) { return this.options.map((o) => p.print(o)).join(' | '); }

  /**
   * For a discriminated union: option index by tag value. A tag that is a
   * ref (e.g. a dynamic enum of registered names) is resolved through the
   * bound env. Options whose tag can't be indexed (a plain string) are the
   * fallback, tried in order.
   */
  private tagIndex(env: ReadonlyMap<string, AnySchema>, skip: ReadonlySet<number>): { tag: string; byTag: Map<unknown, number>; fallback: number[] } | undefined {
    const tag = this.tag ?? autoTag(this.options, env);
    if (!tag) return undefined;
    const byTag = new Map<unknown, number>();
    const fallback: number[] = [];
    this.options.forEach((o, i) => {
      const values = skip.has(i) ? undefined : tagValues(o, tag, env);
      if (values) { for (const v of values) if (!byTag.has(v)) byTag.set(v, i); }
      else fallback.push(i);
    });
    return { tag, byTag, fallback };
  }

  private label(i: number, env: ReadonlyMap<string, AnySchema>): string {
    const tagSchema = this.tag ? (deref(this.options[i], env) as unknown as ObjectType<Shape>).shape?.[this.tag] : undefined;
    if (tagSchema instanceof LiteralType && typeof tagSchema.value === 'string') return tagSchema.value;
    return `option${i + 1}`;
  }

  compile(c: Compiler): Node {
    // Options that admit nothing (`never`, an empty enum) are left out; none left → never.
    if (this.options.some((o) => isNever(o, c.env))) {
      const live = this.options.filter((o) => !isNever(o, c.env));
      if (!live.length) return neverNode(c, () => this.ruleHint());
      const u = this.with({ options: live as unknown as O });
      const n = u.compile(c);
      return n;
    }
    const tagged = c.profile.unions === 'tagged';
    // An option written as JSON text (an escape, "any" on a strict dialect) is a
    // string on the wire: next to other options it would be ambiguous (a plain
    // string option matches it), so it is wrapped as `{ "json": "…" }`.
    const wrapped = new Set<number>();
    const compiled = this.options.map((o) => c.compile(o));
    // Every option became JSON text (depth, recursion): the union itself is one JSON text.
    if (compiled.length > 1 && compiled.every((n) => n.jsonText)) return c.escape(this, 'Nested too deep for this model to describe directly.');
    const nodes = compiled.map((n, i, all) => {
      if (tagged || all.length < 2 || !n.jsonText) return n;
      wrapped.add(i);
      return jsonWrapped(c, n);
    });
    // A wrapped option has no tag on the wire: it is found by trying it.
    const index = this.tagIndex(c.env, wrapped);
    const byTag = index?.byTag;
    const tag = index?.tag;
    const labels = this.options.map((_, i) => this.label(i, c.env));
    const pick = (v: unknown, cx: Cx): number => {
      if (byTag && isObject(v)) {
        const i = byTag.get((v as Record<string, unknown>)[tag!]);
        if (i !== undefined) return i;
      }
      // No tag on the value (a JSON string to repair, an option written as JSON text): try every option.
      const untagged = !isObject(v) || (v as Record<string, unknown>)[tag!] === undefined;
      for (const i of index && !untagged ? index.fallback : nodes.keys()) {
        const d = cx.dryRun();
        nodes[i]!.run(v, d);
        if (!d.errors.length) return i;
      }
      return -1;
    };
    const printer = () => new Printer(c.env);
    return c.node({
      own: tagged,
      deps: nodes,
      hint: () => this.hintOf(tagged ? ['Fill exactly one of these fields and set the others to null.'] : []),
      emit: () => {
        if (tagged) {
          const properties: Record<string, JsonSchema> = {};
          nodes.forEach((n, i) => (properties[labels[i]!] = c.nullable(n.json())));
          return c.object(properties, labels);
        }
        return { anyOf: nodes.map((n) => n.json()) };
      },
      run: (v, cx) => {
        if (tagged) {
          if (!isObject(v)) return fail(cx, v, `Expected an object with one of: ${labels.join(', ')}.`);
          const set = labels.filter((l) => (v as Record<string, unknown>)[l] != null);
          if (set.length !== 1) return fail(cx, v, `Fill exactly one of: ${labels.join(', ')} (got ${set.length}).`);
          const i = labels.indexOf(set[0]!);
          cx.enter(set[0]!, null);
          // The wrapper is dropped; the chosen value is returned as is.
          const out = nodes[i]!.run((v as Record<string, unknown>)[set[0]!], cx);
          cx.leave(false);
          return out;
        }
        const i = pick(v, cx);
        if (i < 0) {
          if (byTag && !index!.fallback.length && isObject(v) && (v as Record<string, unknown>)[tag!] !== undefined) {
            cx.enter(tag!);
            cx.fail(`Expected ${tag} to be one of: ${[...byTag.keys()].map((k) => JSON.stringify(k)).join(', ')}.`);
            cx.leave();
            return v;
          }
          // One option whose literal fields (a `kind`) the value carries: its own errors say more.
          const best = closestOption(this.options, v, c.env);
          if (best >= 0) return nodes[best]!.run(v, cx);
          return fail(cx, v, `Did not match any of: ${this.options.map((o) => o.print(printer())).join(' | ')}.`);
        }
        return nodes[i]!.run(v, cx);
      },
      encode: (v, st) => {
        const i = this.optionOf(v, c, byTag, tag);
        if (i < 0) return v;
        const enc = nodes[i]!.encode(v, st);
        if (!tagged) return enc;
        st.objects++;
        return Object.fromEntries(labels.map((l, j) => [l, j === i ? enc : null]));
      },
      // A part of a union: the options that have that part; which one is decided by the value encoded.
      child: (seg) => {
        const kids = nodes.map((n) => n.child(seg)).filter((k): k is Node => !!k);
        if (kids.length <= 1) return kids[0];
        const pickKid = (v: unknown) => kids.find((k) => !k.schema || matches(c, k.schema, v)) ?? kids[0]!;
        const n = c.node({
          deps: kids,
          emit: () => ({ anyOf: kids.map((k) => k.json()) }),
          run: (v, cx) => pickKid(v).run(v, cx),
          encode: (v, st) => pickKid(v).encode(v, st),
          child: (s) => kids[0]!.child(s),
        });
        n.needs = kids.some((k) => k.needs);
        return n;
      },
    });
  }

  /** Which option a CODE value belongs to (by tag, else the first whose code shape accepts it). */
  private optionOf(v: unknown, c: Compiler, byTag: Map<unknown, number> | undefined, tag: string | undefined): number {
    if (byTag && isObject(v)) {
      const i = byTag.get((v as Record<string, unknown>)[tag!]);
      if (i !== undefined) return i;
    }
    const lenient = c.lenient();
    return this.options.findIndex((o) => {
      const d = new Cx(false, true, newStats(), false);
      lenient.nodeFor(o).run(v, d);
      return d.errors.length === 0;
    });
  }
}

/**
 * Every member at once (`allOf`; gin's `and`). Objects are MERGED into one
 * object, which every dialect can say. Otherwise the first member is the
 * wire shape; the rest are `allOf` where the dialect has it (and no member
 * changes shape) or words, and always validated on the decoded value.
 */
export class IntersectionType<T extends readonly [AnySchema, ...AnySchema[]]> extends Schema<IntersectOut<T>, RefsOf<T[number]>> {
  readonly kind = 'intersection' as const;
  constructor(readonly members: T) { super(); }
  children() { return this.members; }
  print(p: Printer) { return this.members.map((m) => p.print(m)).join(' & '); }
  private readonly mergedByEnv = new WeakMap<object, AnySchema | null>();

  /** The members as one object, when every member is (or refers to) an object. */
  merged(env: ReadonlyMap<string, AnySchema>): AnySchema | undefined {
    let m = this.mergedByEnv.get(env);
    if (m === undefined) {
      const objs = this.members.map((x) => deref(x, env));
      if (objs.every((o) => o instanceof ObjectType)) {
        const os = objs as ObjectType<Shape, AnySchema | undefined>[];
        const shape: Record<string, AnySchema> = {};
        for (const o of os) Object.assign(shape, o.shape);
        const rest = os.map((o) => o.extras.rest).filter(Boolean).at(-1);
        const patterns = os.flatMap((o) => o.extras.patterns ?? []);
        const merged = new ObjectType(shape, os.some((o) => o.closed), { ...(rest ? { rest } : {}), ...(patterns.length ? { patterns } : {}) });
        m = merged.with({ checks: [...os.flatMap((o) => o.checks), ...this.checks], meta: this.meta });
      } else m = null;
      this.mergedByEnv.set(env, m);
    }
    return m ?? undefined;
  }

  compile(c: Compiler): Node {
    const merged = this.merged(c.env);
    if (merged) {
      const n = c.compile(merged);
      return c.node({ deps: [n], emit: () => n.json(), run: (v, cx) => n.run(v, cx), encode: (v, st) => n.encode(v, st), child: (s) => n.child(s) });
    }
    const nodes = this.members.map((m) => c.compile(m));
    const rest = this.members.slice(1);
    const asAllOf = () => c.profile.allOf && nodes.every((n) => !n.needs);
    return c.node({
      deps: nodes,
      hint: () => this.hintOf(asAllOf() ? [] : [`Must also be: ${rest.map((m) => m.print(new Printer(c.env))).join(' & ')}.`]),
      emit: () => (asAllOf() ? { allOf: nodes.map((n) => n.json()) } : nodes[0]!.json()),
      run: (v, cx) => {
        const before = cx.errors.length;
        const out = nodes[0]!.run(v, cx);
        if (cx.errors.length !== before) return out;
        const lenient = c.lenient();
        for (const m of rest) {
          const d = cx.dryRun();
          lenient.nodeFor(m).run(out, d);
          for (const e of d.errors) cx.errors.push(e);
        }
        return out;
      },
      encode: (v, st) => nodes[0]!.encode(v, st),
      child: (s) => nodes[0]!.child(s),
    });
  }
}

type IntersectOut<T extends readonly AnySchema[]> =
  T extends readonly [infer H extends AnySchema, ...infer Rest extends readonly AnySchema[]]
    ? Rest extends readonly [] ? OutOf<H> : OutOf<H> & IntersectOut<Rest>
    : unknown;

/** A value of `base` that must NOT match `excluded` (gin's `not<T>`; JSON Schema `not`). */
export class NotType<B extends AnySchema> extends Schema<OutOf<B>, RefsOf<B>> {
  readonly kind = 'not' as const;
  constructor(readonly excluded: AnySchema, readonly base: B) { super(); }
  children() { return [this.base, this.excluded]; }
  print(p: Printer) { return p.print(this.base); }
  compile(c: Compiler): Node {
    const base = c.compile(this.base);
    const words = () => (c.profile.conditionals ? [] : [`Must not be: ${this.excluded.print(new Printer(c.env))}.`]);
    return c.node({
      deps: [base],
      hint: () => this.hintOf(words()),
      emit: () => (c.profile.conditionals ? { ...base.json(), not: c.lenient().nodeFor(this.excluded).json() } : base.json()),
      run: (v, cx) => {
        const before = cx.errors.length;
        const out = base.run(v, cx);
        if (cx.errors.length === before && matches(c, this.excluded, out)) cx.fail(`Must not be: ${this.excluded.print(new Printer(c.env))}.`);
        return out;
      },
      encode: (v, st) => base.encode(v, st),
      child: (s) => base.child(s),
    });
  }
}

/** `if`/`then`/`else`: a value of `base`; when it matches `if` it must match `then`, otherwise `else`. */
export class ConditionalType<B extends AnySchema> extends Schema<OutOf<B>, RefsOf<B>> {
  readonly kind = 'conditional' as const;
  constructor(readonly base: B, readonly when: AnySchema, readonly then?: AnySchema, readonly otherwise?: AnySchema) { super(); }
  children() { return [this.base, this.when, ...(this.then ? [this.then] : []), ...(this.otherwise ? [this.otherwise] : [])]; }
  print(p: Printer) { return p.print(this.base); }
  compile(c: Compiler): Node {
    const base = c.compile(this.base);
    const ts = (s: AnySchema) => s.print(new Printer(c.env));
    const rule = [
      this.then ? `If it is ${ts(this.when)}, it must also be ${ts(this.then)}.` : '',
      this.otherwise ? `${this.then ? 'Otherwise' : `If it is not ${ts(this.when)}`}, it must be ${ts(this.otherwise)}.` : '',
    ].filter(Boolean).join(' ');
    return c.node({
      deps: [base],
      hint: () => this.hintOf(c.profile.conditionals ? [] : [rule]),
      emit: () => {
        if (!c.profile.conditionals) return base.json();
        const l = c.lenient();
        return {
          ...base.json(),
          if: l.nodeFor(this.when).json(),
          ...(this.then ? { then: l.nodeFor(this.then).json() } : {}),
          ...(this.otherwise ? { else: l.nodeFor(this.otherwise).json() } : {}),
        };
      },
      run: (v, cx) => {
        const before = cx.errors.length;
        const out = base.run(v, cx);
        if (cx.errors.length !== before) return out;
        const branch = matches(c, this.when, out) ? this.then : this.otherwise;
        if (branch && !matches(c, branch, out)) cx.fail(rule);
        return out;
      },
      encode: (v, st) => base.encode(v, st),
      child: (s) => base.child(s),
    });
  }
}

/**
 * A field typed by a sibling's value (see `ObjectType.dependent`). On its
 * own it is just `base`; inside an object the object decodes it last and
 * checks it against `schemaFor(sibling)`, rendered in the code shape (as
 * JSON text inside an escape hatch is). `schemaFor` should return cached
 * schemas: each new instance is compiled on first use.
 */
export class DependentType<Out = unknown> extends Schema<Out> {
  readonly kind = 'dependent' as const;
  constructor(
    readonly on: string,
    readonly schemaFor: (sibling: unknown) => AnySchema | undefined,
    readonly base: AnySchema = new AnyType(),
  ) { super(); }
  children() { return [this.base]; }
  print(p: Printer) { return p.print(this.base); }
  compile(c: Compiler): Node {
    const base = c.compile(this.base);
    return c.node({
      deps: [base],
      hint: () => this.ruleHint(),
      emit: () => base.json(),
      run: (v, cx) => base.run(v, cx),
      encode: (v, st) => base.encode(v, st),
    });
  }
}

// ============================================================================
// Never
// ============================================================================

/**
 * No value at all (zod's `never`). Used where a runtime list comes out empty:
 * query's `joins` when no type has a relation, a function name when no
 * function is selected. A union leaves never options out; a list of never
 * must be empty; an optional object field of never is not shown to the
 * model (and refused if sent).
 */
export class NeverType extends Schema<never> {
  readonly kind = 'never' as const;
  children() { return []; }
  print() { return 'never'; }
  compile(c: Compiler): Node {
    return neverNode(c, () => this.ruleHint());
  }
}

/** Does this schema (through refs) admit no value at all? */
export function isNever(s: AnySchema | undefined, env: ReadonlyMap<string, AnySchema>): boolean {
  const d = deref(s, env);
  if (!d) return false;
  if (d.kind === 'never') return true;
  if (d instanceof EnumType) return d.values.length === 0;
  if (d instanceof UnionType) return d.options.every((o: AnySchema) => isNever(o, env));
  return false;
}

/** The node of a schema that admits nothing: `{not: {}}` where the dialect has `not`, else a null that is refused. */
function neverNode(c: Compiler, rules: () => string | undefined): Node {
  return c.node({
    hint: () => ['No value is allowed here.', rules()].filter(Boolean).join(' '),
    emit: () => (c.profile.conditionals ? { not: {} } : { type: 'null' }),
    run: (v, cx) => fail(cx, v, 'No value is allowed here.'),
    encode: (v) => v,
  });
}

// ============================================================================
// Wrappers
// ============================================================================

/**
 * A value that may be left out and then reads as `value` (zod's `.default`).
 * In an object the key is optional for the model (or `null` where absent is
 * written null) and REQUIRED in the code shape: decoding writes the default
 * in. Outside an object `undefined` decodes to the default.
 */
export class DefaultType<T extends AnySchema> extends Schema<Exclude<OutOf<T>, undefined>, RefsOf<T>> {
  readonly kind = 'default' as const;
  constructor(readonly inner: T, readonly value: Exclude<OutOf<T>, undefined>) { super(); }
  children() { return [this.inner]; }
  print(p: Printer) { return p.print(this.inner); }
  /** A fresh copy of the default (containers are never shared between decoded values). */
  fresh(stats?: CopyStats): unknown {
    const v = this.value as unknown;
    if (typeof v !== 'object' || v === null) return v;
    if (stats) { if (Array.isArray(v)) stats.arrays++; else stats.objects++; }
    return structuredClone(v);
  }
  compile(c: Compiler): Node {
    const inner = c.guarded(this.inner, this);
    const nullMode = c.profile.optional === 'null';
    const nullable = this.inner instanceof NullableType;
    return c.node({
      own: true,
      deps: [inner],
      hint: () => this.hintOf([`Default when left out: ${JSON.stringify(inner.encode(this.value))}.`]),
      emit: () => (nullMode && !nullable ? c.nullable(inner.json()) : inner.json()),
      run: (v, cx) => (v === undefined || (v === null && nullMode && !nullable) ? this.fresh(cx.dry ? undefined : cx.stats) : inner.run(v, cx)),
      encode: (v, st) => inner.encode(v, st),
      child: (seg) => inner.child(seg),
    });
  }
}

export class OptionalType<T extends AnySchema> extends Schema<OutOf<T> | undefined, RefsOf<T>> {
  readonly kind = 'optional' as const;
  constructor(readonly inner: T) { super(); }
  children() { return [this.inner]; }
  print(p: Printer) { return `${p.print(this.inner)} | undefined`; }
  /** Outside an object (array element, root): null-for-absent becomes `undefined`. */
  compile(c: Compiler): Node {
    const inner = c.guarded(this.inner, this);
    const nullMode = c.profile.optional === 'null';
    return c.node({
      own: nullMode,
      deps: [inner],
      emit: () => (nullMode ? c.nullable(inner.json()) : inner.json()),
      run: (v, cx) => (v === undefined ? v : v === null && nullMode && !(this.inner instanceof NullableType) ? undefined : inner.run(v, cx)),
      encode: (v, st) => (v === undefined ? (nullMode ? null : undefined) : inner.encode(v, st)),
      child: (s) => inner.child(s),
    });
  }
}

export class NullableType<T extends AnySchema> extends Schema<OutOf<T> | null, RefsOf<T>> {
  readonly kind = 'nullable' as const;
  constructor(readonly inner: T) { super(); }
  children() { return [this.inner]; }
  print(p: Printer) { return `${p.print(this.inner)} | null`; }
  compile(c: Compiler): Node {
    const inner = c.guarded(this.inner);
    return c.node({
      deps: [inner],
      hint: () => this.ruleHint(),
      emit: () => c.nullable(inner.json()),
      run: (v, cx) => (v === null ? v : inner.run(v, cx)),
      encode: (v, st) => (v === null ? null : inner.encode(v, st)),
      child: (s) => inner.child(s),
    });
  }
}

/** A use of a named type, defined in the chain (statically or by the dynamic step). */
export class RefType<N extends string, Out = RefMarker<N>, R extends string = N> extends Schema<Out, R> {
  readonly kind = 'ref' as const;
  constructor(readonly name: N) { super(); }
  children() { return []; }
  print(p: Printer) { return p.ref(this.name); }
  compile(c: Compiler): Node {
    return c.ref(this.name);
  }
}

/**
 * A value whose CODE form differs from what the model writes — e.g. a fn
 * name the model spells `sys__a__b` and the code calls `sys/a.b`. The model
 * sees `wire`; decoding maps through `decode`, examples through `encode`.
 */
export class CodecType<W extends AnySchema, Out> extends Schema<Out, RefsOf<W>> {
  readonly kind = 'codec' as const;
  constructor(
    readonly wire: W,
    readonly codec: { readonly decode: (wire: OutOf<W>) => Out | Error; readonly encode: (value: Out) => OutOf<W> },
  ) { super(); }
  children() { return [this.wire]; }
  print(p: Printer) { return p.print(this.wire); }
  compile(c: Compiler): Node {
    const inner = c.compile(this.wire);
    return c.node({
      own: true,
      deps: [inner],
      hint: () => this.ruleHint(),
      emit: () => inner.json(),
      run: (v, cx) => {
        const before = cx.errors.length;
        const w = inner.run(v, cx);
        if (cx.errors.length !== before) return v;
        const out = this.codec.decode(w as OutOf<W>);
        if (out instanceof Error) return fail(cx, v, out.message);
        return out;
      },
      encode: (v, st) => inner.encode(this.codec.encode(v as Out), st),
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function kind(v: unknown): string {
  return v === null ? 'null' : Array.isArray(v) ? 'a list' : typeof v === 'object' ? 'an object' : typeof v;
}

function jsonType(v: LiteralValue): string {
  return typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'null';
}

function fail(cx: Cx, v: unknown, message: string): unknown {
  cx.fail(message);
  return v;
}

/** The tag values an option can have at `key` (through refs and nested unions); undefined when not a fixed set. */
function tagValues(o: AnySchema | undefined, key: string, env: ReadonlyMap<string, AnySchema>, depth = 0): unknown[] | undefined {
  const d = deref(o, env);
  if (d instanceof ObjectType) {
    const t = deref((d.shape as Shape)[key], env);
    if (t instanceof LiteralType) return [t.value];
    if (t instanceof EnumType) return [...t.values];
    return undefined;
  }
  if (d instanceof UnionType && depth < 8) {
    const out: unknown[] = [];
    for (const x of d.options as readonly AnySchema[]) {
      const v = tagValues(x, key, env, depth + 1);
      if (!v) return undefined;
      out.push(...v);
    }
    return out;
  }
  return undefined;
}

/** The object keys an option has (first object reached through refs / nested unions). */
function optionKeys(o: AnySchema | undefined, env: ReadonlyMap<string, AnySchema>, depth = 0): string[] {
  const d = deref(o, env);
  if (d instanceof ObjectType) return Object.keys(d.shape);
  if (d instanceof UnionType && depth < 8) return optionKeys((d.options as readonly AnySchema[])[0], env, depth + 1);
  return [];
}

const autoTags = new WeakMap<readonly AnySchema[], WeakMap<object, string | null>>();
/**
 * A union whose options are all objects with a literal field (`kind`) of
 * DISJOINT values is discriminated by it even when not declared so: decoding
 * picks the option by tag (no trial parses) and reports errors inside it.
 */
function autoTag(options: readonly AnySchema[], env: ReadonlyMap<string, AnySchema>): string | undefined {
  let byEnv = autoTags.get(options);
  if (!byEnv) autoTags.set(options, (byEnv = new WeakMap()));
  let found = byEnv.get(env);
  if (found === undefined) {
    found = null;
    if (options.length > 1) {
      for (const key of optionKeys(options[0], env)) {
        const seen = new Set<unknown>();
        let ok = true;
        for (const o of options) {
          const vs = tagValues(o, key, env);
          if (!vs || vs.some((v) => seen.has(v))) { ok = false; break; }
          for (const v of vs) seen.add(v);
        }
        if (ok) { found = key; break; }
      }
    }
    byEnv.set(env, found);
  }
  return found ?? undefined;
}

/** The only option whose literal fields the value matches (the most of them), or -1. */
function closestOption(options: readonly AnySchema[], v: unknown, env: ReadonlyMap<string, AnySchema>): number {
  if (!isObject(v)) return -1;
  const rec = v as Record<string, unknown>;
  let best = -1;
  let bestScore = 0;
  let tie = false;
  options.forEach((o, i) => {
    let score = 0;
    for (const k of optionKeys(o, env)) {
      const vs = tagValues(o, k, env);
      if (vs && k in rec) score += vs.includes(rec[k]) ? 1 : -1;
    }
    if (score > bestScore) { best = i; bestScore = score; tie = false; }
    else if (score === bestScore && score > 0) tie = true;
  });
  return tie ? -1 : best;
}

/** A JSON-text option inside a union, written as `{ "json": "…" }` so it can't be mistaken for a string option. */
function jsonWrapped(c: Compiler, n: Node): Node {
  const w = c.node({
    own: true,
    deps: [n],
    emit: () => c.object({ json: n.json() }, ['json']),
    run: (v, cx) => {
      if (!isObject(v) || !('json' in v)) return fail(cx, v, 'Expected {"json": "<JSON text>"}.');
      cx.enter('json', null);
      const out = n.run((v as { json: unknown }).json, cx);
      cx.leave(false);
      return out;
    },
    encode: (v, st) => { st.objects++; return { json: n.encode(v, st) }; },
  });
  c.nodes.push(w);
  return w;
}

/** Follow refs to the schema they name (bounded). */
function deref(s: AnySchema | undefined, env: ReadonlyMap<string, AnySchema>): AnySchema | undefined {
  for (let hops = 0; s instanceof RefType && hops < 16; hops++) s = env.get(s.name);
  return s;
}

/** Does a CODE value match a schema (its lenient rendering)? */
function matches(c: Compiler, s: AnySchema, value: unknown): boolean {
  const d = new Cx(false, true, newStats(), false);
  c.lenient().nodeFor(s).run(value, d);
  return d.errors.length === 0;
}

/** Emit a constraint keyword, or (when the dialect lacks it) say it in words. */
function keyword(j: JsonSchema, words: string[], key: string, value: unknown, supported: boolean, phrase: string): void {
  if (value === undefined) return;
  if (supported) j[key] = value;
  else if (!words.includes(phrase)) words.push(phrase);
}

/**
 * Repair a container sent as a string of JSON text (also double-encoded).
 * Only when the parsed value is the container that was expected; anything
 * else is left for the normal error.
 */
function repairJson(v: unknown, cx: Cx, want: 'object' | 'array'): unknown {
  if (!cx.repair || typeof v !== 'string') return v;
  let x: unknown = v;
  for (let i = 0; i < 2 && typeof x === 'string'; i++) {
    const t = x.trim();
    if (!/^[[{"]/.test(t)) return v;
    try {
      x = JSON.parse(t);
    } catch {
      return v;
    }
  }
  if (want === 'array' ? Array.isArray(x) : isObject(x)) {
    if (!cx.dry) cx.stats.repaired++;
    return x;
  }
  return v;
}

/** Encode a list copy-on-write: a new array only when an item's encoding differs. */
function encodeItems(arr: unknown[], enc: (x: unknown, i: number) => unknown, st: CopyStats): unknown[] {
  let out = arr;
  for (let i = 0; i < arr.length; i++) {
    const e = enc(arr[i], i);
    if (e !== arr[i]) {
      if (out === arr) { out = arr.slice(); st.arrays++; }
      out[i] = e;
    }
  }
  return out;
}

/** Write a decoded child into its parent: in place, or clone the parent once (copy-on-write). */
function writeKey(out: Record<string, unknown>, orig: Record<string, unknown>, key: string, value: unknown, cx: Cx): Record<string, unknown> {
  if (cx.inPlace) {
    orig[key] = value;
    cx.stats.edits++;
    return orig;
  }
  if (out === orig) {
    out = { ...orig };
    cx.stats.objects++;
  }
  out[key] = value;
  return out;
}

function deleteKey(out: Record<string, unknown>, orig: Record<string, unknown>, key: string, cx: Cx): Record<string, unknown> {
  if (cx.inPlace) {
    delete orig[key];
    cx.stats.edits++;
    return orig;
  }
  if (out === orig) {
    out = { ...orig };
    cx.stats.objects++;
  }
  delete out[key];
  return out;
}

function writeIndex(out: unknown[], orig: unknown[], i: number, value: unknown, cx: Cx): unknown[] {
  if (cx.inPlace) {
    orig[i] = value;
    cx.stats.edits++;
    return orig;
  }
  if (out === orig) {
    out = orig.slice();
    cx.stats.arrays++;
  }
  out[i] = value;
  return out;
}

export type { JsonValue, PathSeg };
