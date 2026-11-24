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
import { Cx, Printer, withNull, type Compiler, type JsonSchema, type Node, type Rendered } from './render';
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
  | 'object' | 'record' | 'union' | 'optional' | 'nullable' | 'ref' | 'any' | 'codec';

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
  describe(text: Text): AnySchema;
  title(title: string): AnySchema;
  example(...values: any[]): AnySchema;
  refine(fn: (value: any) => boolean | string, message?: string, opts?: { visible?: boolean }): AnySchema;
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

  protected with(patch: { meta?: Meta; checks?: readonly Check[] }): this {
    const c = Object.create(Object.getPrototypeOf(this)) as this;
    Object.assign(c, this, patch);
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
}

// ============================================================================
// Scalars
// ============================================================================

export interface StringOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly format?: string;
}

export class StringType extends Schema<string> {
  readonly kind = 'string' as const;
  constructor(readonly options: StringOptions = {}) { super(); }
  children() { return []; }
  min(n: number): this { return this.opts({ minLength: n }); }
  max(n: number): this { return this.opts({ maxLength: n }); }
  pattern(re: RegExp | string): this { return this.opts({ pattern: typeof re === 'string' ? re : re.source }); }
  format(f: string): this { return this.opts({ format: f }); }
  private opts(o: StringOptions): this {
    const c = this.with({});
    (c as { options: StringOptions }).options = { ...this.options, ...o };
    return c;
  }
  print() { return 'string'; }
  compile(c: Compiler): Node {
    const o = this.options;
    const re = o.pattern !== undefined ? new RegExp(o.pattern) : undefined;
    const words: string[] = [];
    return c.node({
      hint: () => (words.length ? words.join(' ') : undefined) ?? this.ruleHint(),
      emit: () => {
        const j: JsonSchema = { type: 'string' };
        constraint(c.profile, j, words, 'minLength', o.minLength, `At least ${o.minLength} characters.`);
        constraint(c.profile, j, words, 'maxLength', o.maxLength, `At most ${o.maxLength} characters.`);
        constraint(c.profile, j, words, 'pattern', o.pattern, `Must match /${o.pattern}/.`);
        if (o.format) j.format = o.format;
        return j;
      },
      run: (v, cx) => {
        if (typeof v !== 'string') return fail(cx, v, `Expected a string, got ${kind(v)}.`);
        if (o.minLength !== undefined && v.length < o.minLength) cx.fail(`Must be at least ${o.minLength} characters.`);
        if (o.maxLength !== undefined && v.length > o.maxLength) cx.fail(`Must be at most ${o.maxLength} characters.`);
        if (re && !re.test(v)) cx.fail(`Must match /${o.pattern}/.`);
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
    const c = this.with({});
    (c as { options: NumberOptions }).options = { ...this.options, ...o };
    return c;
  }
  print() { return 'number'; }
  compile(c: Compiler): Node {
    const o = this.options;
    const words: string[] = [];
    return c.node({
      hint: () => (words.length ? words.join(' ') : undefined) ?? this.ruleHint(),
      emit: () => {
        const j: JsonSchema = { type: o.int ? 'integer' : 'number' };
        constraint(c.profile, j, words, 'minimum', o.minimum, `At least ${o.minimum}.`);
        constraint(c.profile, j, words, 'maximum', o.maximum, `At most ${o.maximum}.`);
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
  print() { return this.values.map((v) => JSON.stringify(v)).join(' | '); }
  compile(c: Compiler): Node {
    const values = this.values;
    const set = new Set<string>(values);
    const cap = c.profile.maxEnumValues;
    const widened = cap !== undefined && values.length > cap;
    return c.node({
      // Over the dialect's cap the enum is WIDENED (never truncated): every
      // value moves into the description, and decoding still enforces it.
      hint: () => (widened ? `One of: ${values.join(', ')}.` : this.ruleHint()),
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
    if (c.profile.any === 'empty') {
      return c.node({ emit: () => ({}), run: (v) => v, encode: (v) => v });
    }
    // No spelling for "any value" in this dialect: JSON text, parsed on decode.
    return c.node({
      own: true,
      hint: () => 'Write the value as JSON text.',
      emit: () => ({ type: 'string' }),
      run: (v, cx) => {
        if (typeof v !== 'string') return fail(cx, v, 'Expected JSON text in a string.');
        try {
          const out = JSON.parse(v);
          cx.stats.parsed++;
          return out;
        } catch (e) {
          return fail(cx, v, `Not valid JSON text: ${(e as Error).message}`);
        }
      },
      encode: (v) => JSON.stringify(v),
    });
  }
}

// ============================================================================
// Containers
// ============================================================================

export class ArrayType<E extends AnySchema> extends Schema<OutOf<E>[], RefsOf<E>> {
  readonly kind = 'array' as const;
  constructor(readonly element: E, readonly options: { readonly minItems?: number; readonly maxItems?: number } = {}) { super(); }
  children() { return [this.element]; }
  min(n: number): this { return this.opts({ minItems: n }); }
  max(n: number): this { return this.opts({ maxItems: n }); }
  private opts(o: { minItems?: number; maxItems?: number }): this {
    const c = this.with({});
    (c as { options: object }).options = { ...this.options, ...o };
    return c;
  }
  print(p: Printer) {
    const inner = p.print(this.element);
    return /[|&]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
  }
  compile(c: Compiler): Node {
    const el = c.compile(this.element);
    const o = this.options;
    const words: string[] = [];
    return c.node({
      deps: [el],
      hint: () => (words.length ? words.join(' ') : undefined) ?? this.ruleHint(),
      emit: () => {
        const j: JsonSchema = { type: 'array', items: el.json() };
        constraint(c.profile, j, words, 'minItems', o.minItems, `At least ${o.minItems} items.`);
        constraint(c.profile, j, words, 'maxItems', o.maxItems, `At most ${o.maxItems} items.`);
        return j;
      },
      run: (v, cx) => {
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
      encode: (v) => (v as unknown[]).map((x) => el.encode(x)),
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
      hint: () => (mode === 'object' ? `Positions are written as keys "0".."${n - 1}".` : mode === 'array' ? `Exactly ${n} items, in order: ${this.items.map((i) => i.print(new Printer(new Map()))).join(', ')}.` : undefined),
      emit: () => {
        if (mode === 'object') {
          const properties: Record<string, JsonSchema> = {};
          nodes.forEach((x, i) => (properties[String(i)] = x.json()));
          return closeObject(c.profile, { type: 'object', properties, required: Object.keys(properties) });
        }
        if (mode === 'prefixItems') return { type: 'array', prefixItems: nodes.map((x) => x.json()), minItems: n, maxItems: n };
        return { type: 'array', items: { anyOf: nodes.map((x) => x.json()) } };
      },
      run: (v, cx) => {
        if (mode === 'object') {
          if (!isObject(v)) return fail(cx, v, 'Expected an object with keys "0".."' + (n - 1) + '".');
          // Shape change: one new array; the item values are moved, not copied.
          const arr = new Array(n);
          for (let i = 0; i < n; i++) arr[i] = (v as Record<string, unknown>)[String(i)];
          if (!cx.dry) cx.stats.arrays++;
          const out = runItems(arr, cx, (i) => String(i));
          return cx.dry ? v : out;
        }
        if (!Array.isArray(v)) return fail(cx, v, `Expected a list of ${n} items.`);
        if (v.length !== n) cx.fail(`Expected exactly ${n} items.`);
        return runItems(v, cx, (i) => i);
      },
      encode: (v) => {
        const arr = (v as unknown[]).map((x, i) => nodes[i]!.encode(x));
        if (mode !== 'object') return arr;
        const o: Record<string, unknown> = {};
        arr.forEach((x, i) => (o[String(i)] = x));
        return o;
      },
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

export class ObjectType<S extends Shape> extends Schema<ObjectOut<S>, ShapeRefs<S>> {
  readonly kind = 'object' as const;
  constructor(readonly shape: S, readonly closed = false) { super(); }
  children() { return Object.values(this.shape); }
  /** Unknown keys are an error (default: left in place untouched — no copy to strip them). */
  strict(): this {
    const c = this.with({});
    (c as { closed: boolean }).closed = true;
    return c;
  }
  extend<S2 extends Shape>(more: S2): ObjectType<Simplify<Omit<S, keyof S2> & S2>> {
    return new ObjectType({ ...this.shape, ...more } as Simplify<Omit<S, keyof S2> & S2>, this.closed);
  }
  print(p: Printer) {
    const parts = Object.entries(this.shape).map(([k, s]) => {
      const opt = s instanceof OptionalType;
      return `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}${opt ? '?' : ''}: ${p.print(opt ? s.inner : s)}`;
    });
    return `{ ${parts.join('; ')} }`;
  }
  compile(c: Compiler): Node {
    const nullMode = c.profile.optional === 'null';
    const forModel = c.profile.audience !== 'people';
    const fields: { key: string; optional: boolean; node: Node; nullable: boolean }[] = [];
    const hidden = new Set<string>();
    for (const [key, s] of Object.entries(this.shape)) {
      if (forModel && s.meta.audience === 'people') {
        hidden.add(key);
        continue;
      }
      const optional = s instanceof OptionalType;
      const inner = optional ? (s as OptionalType<AnySchema>).inner : s;
      fields.push({ key, optional, node: c.compile(inner, optional ? s : undefined), nullable: inner instanceof NullableType });
    }
    const known = new Set(Object.keys(this.shape));
    return c.node({
      own: nullMode && fields.some((f) => f.optional && !f.nullable),
      deps: fields.map((f) => f.node),
      hint: () => this.ruleHint(),
      emit: () => {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        for (const f of fields) {
          let j = f.node.json();
          if (f.optional && nullMode) {
            j = withNull(j);
            j.description = [j.description, 'Write null to leave it out.'].filter(Boolean).join('\n');
          }
          properties[f.key] = j;
          if (!f.optional || nullMode) required.push(f.key);
        }
        const j: JsonSchema = { type: 'object', properties, required };
        return this.closed ? { ...j, additionalProperties: false } : closeObject(c.profile, j);
      },
      run: (v, cx) => {
        if (!isObject(v)) return fail(cx, v, `Expected an object, got ${kind(v)}.`);
        const obj = v as Record<string, unknown>;
        let out = obj;
        for (const f of fields) {
          const has = Object.prototype.hasOwnProperty.call(obj, f.key);
          const val = has ? obj[f.key] : undefined;
          if (val === undefined) {
            if (!f.optional) { cx.enter(f.key); cx.fail('Required.'); cx.leave(); }
            continue;
          }
          if (val === null && f.optional && nullMode && !f.nullable) {
            // Strict null means ABSENT in the code shape: the key goes, not `undefined`.
            if (!cx.dry) out = deleteKey(out, obj, f.key, cx);
            continue;
          }
          cx.enter(f.key);
          const r = f.node.run(val, cx);
          cx.leave();
          if (r !== val && !cx.dry) out = writeKey(out, obj, f.key, r, cx);
        }
        for (const key of hidden) {
          if (Object.prototype.hasOwnProperty.call(obj, key)) { cx.enter(key); cx.fail('Not allowed.'); cx.leave(); }
        }
        if (this.closed) {
          for (const key of Object.keys(obj)) {
            if (!known.has(key)) { cx.enter(key); cx.fail(`Unknown field "${key}".`); cx.leave(); }
          }
        }
        return out;
      },
      encode: (v) => {
        const obj = v as Record<string, unknown>;
        const out: Record<string, unknown> = {};
        for (const f of fields) {
          const val = obj[f.key];
          if (val === undefined) {
            if (f.optional && nullMode) out[f.key] = null;
            continue;
          }
          out[f.key] = f.node.encode(val);
        }
        return out;
      },
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
    const val = c.compile(this.value);
    const key = c.compile(this.key ?? STRING);
    const pairs = c.profile.records === 'pairs';
    return c.node({
      own: pairs,
      deps: [val, key],
      // The one place that says how a record looks to THIS model. Prose that
      // must mention it uses `view.recordWord` (see `Text`).
      hint: (view) => (pairs ? `A map written as ${view.recordWord}; each key at most once.` : undefined) ?? this.ruleHint(),
      emit: () => {
        if (pairs) {
          return {
            type: 'array',
            items: { type: 'object', properties: { key: key.json(), value: val.json() }, required: ['key', 'value'], additionalProperties: false },
          };
        }
        const j: JsonSchema = { type: 'object', additionalProperties: val.json() };
        if (this.key && !(c.profile.closedObjects)) j.propertyNames = key.json();
        return j;
      },
      run: (v, cx) => {
        if (pairs) {
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
      encode: (v) => {
        const entries = Object.entries(v as Record<string, unknown>);
        if (pairs) return entries.map(([k, x]) => ({ key: k, value: val.encode(x) }));
        return Object.fromEntries(entries.map(([k, x]) => [k, val.encode(x)]));
      },
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
  private tagIndex(env: ReadonlyMap<string, AnySchema>): { byTag: Map<unknown, number>; fallback: number[] } | undefined {
    if (!this.tag) return undefined;
    const byTag = new Map<unknown, number>();
    const fallback: number[] = [];
    this.options.forEach((o, i) => {
      let t: AnySchema | undefined = (o as unknown as ObjectType<Shape>).shape?.[this.tag!];
      for (let hops = 0; t instanceof RefType && hops < 8; hops++) t = env.get(t.name);
      if (t instanceof LiteralType) byTag.set(t.value, i);
      else if (t instanceof EnumType) for (const v of t.values) { if (!byTag.has(v)) byTag.set(v, i); }
      else fallback.push(i);
    });
    return { byTag, fallback };
  }

  private label(i: number): string {
    const tagSchema = this.tag ? (this.options[i] as unknown as ObjectType<Shape>).shape?.[this.tag] : undefined;
    if (tagSchema instanceof LiteralType && typeof tagSchema.value === 'string') return tagSchema.value;
    return `option${i + 1}`;
  }

  compile(c: Compiler): Node {
    const nodes = this.options.map((o) => c.compile(o));
    const index = this.tagIndex(c.env);
    const byTag = index?.byTag;
    const tagged = c.profile.unions === 'tagged';
    const labels = this.options.map((_, i) => this.label(i));
    const pick = (v: unknown, cx: Cx): number => {
      if (byTag && isObject(v)) {
        const i = byTag.get((v as Record<string, unknown>)[this.tag!]);
        if (i !== undefined) return i;
      }
      for (const i of index ? index.fallback : nodes.keys()) {
        const d = cx.dryRun();
        nodes[i]!.run(v, d);
        if (!d.errors.length) return i;
      }
      return -1;
    };
    return c.node({
      own: tagged,
      deps: nodes,
      hint: () => (tagged ? `Fill exactly one of these fields and set the others to null.` : undefined) ?? this.ruleHint(),
      emit: () => {
        if (tagged) {
          const properties: Record<string, JsonSchema> = {};
          nodes.forEach((n, i) => (properties[labels[i]!] = withNull(n.json())));
          return closeObject(c.profile, { type: 'object', properties, required: [...labels] });
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
          if (byTag && !index!.fallback.length) {
            cx.enter(this.tag!);
            cx.fail(`Expected ${this.tag} to be one of: ${[...byTag.keys()].map((k) => JSON.stringify(k)).join(', ')}.`);
            cx.leave();
            return v;
          }
          return fail(cx, v, `Did not match any of: ${this.options.map((o) => o.print(new Printer(new Map()))).join(' | ')}.`);
        }
        return nodes[i]!.run(v, cx);
      },
      encode: (v) => {
        const lenient = c.lenient();
        let i = -1;
        if (byTag && isObject(v)) i = byTag.get((v as Record<string, unknown>)[this.tag!]) ?? -1;
        if (i < 0) {
          i = this.options.findIndex((o) => {
            const d = new Cx(false, true, { objects: 0, arrays: 0, edits: 0, parsed: 0 });
            lenient.nodeFor(o).run(v, d);
            return d.errors.length === 0;
          });
        }
        if (i < 0) return v;
        const enc = nodes[i]!.encode(v);
        if (!tagged) return enc;
        return Object.fromEntries(labels.map((l, j) => [l, j === i ? enc : null]));
      },
    });
  }
}

// ============================================================================
// Wrappers
// ============================================================================

export class OptionalType<T extends AnySchema> extends Schema<OutOf<T> | undefined, RefsOf<T>> {
  readonly kind = 'optional' as const;
  constructor(readonly inner: T) { super(); }
  children() { return [this.inner]; }
  print(p: Printer) { return `${p.print(this.inner)} | undefined`; }
  /** Outside an object (array element, root): null-for-absent becomes `undefined`. */
  compile(c: Compiler): Node {
    const inner = c.compile(this.inner, this);
    const nullMode = c.profile.optional === 'null';
    return c.node({
      own: nullMode,
      deps: [inner],
      emit: () => (nullMode ? withNull(inner.json()) : inner.json()),
      run: (v, cx) => (v === undefined ? v : v === null && nullMode ? undefined : inner.run(v, cx)),
      encode: (v) => (v === undefined ? (nullMode ? null : undefined) : inner.encode(v)),
    });
  }
}

export class NullableType<T extends AnySchema> extends Schema<OutOf<T> | null, RefsOf<T>> {
  readonly kind = 'nullable' as const;
  constructor(readonly inner: T) { super(); }
  children() { return [this.inner]; }
  print(p: Printer) { return `${p.print(this.inner)} | null`; }
  compile(c: Compiler): Node {
    const inner = c.compile(this.inner);
    return c.node({
      deps: [inner],
      emit: () => withNull(inner.json()),
      run: (v, cx) => (v === null ? v : inner.run(v, cx)),
      encode: (v) => (v === null ? null : inner.encode(v)),
    });
  }
}

/** A use of a named type, defined in the chain (statically or by the dynamic step). */
export class RefType<N extends string> extends Schema<RefMarker<N>, N> {
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
      emit: () => inner.json(),
      run: (v, cx) => {
        const before = cx.errors.length;
        const w = inner.run(v, cx);
        if (cx.errors.length !== before) return v;
        const out = this.codec.decode(w as OutOf<W>);
        if (out instanceof Error) return fail(cx, v, out.message);
        return out;
      },
      encode: (v) => inner.encode(this.codec.encode(v as Out)),
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

function closeObject(profile: Profile, j: JsonSchema): JsonSchema {
  return profile.closedObjects ? { ...j, additionalProperties: false } : j;
}

/** Emit a constraint keyword, or (when the dialect lacks them) say it in words. */
function constraint(profile: Profile, j: JsonSchema, words: string[], key: string, value: unknown, phrase: string): void {
  if (value === undefined) return;
  if (profile.constraints) j[key] = value;
  else if (!words.includes(phrase)) words.push(phrase);
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

export type { JsonValue };
