import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type NewSlotVisitor, type Prop, type Rnd, Type, ENVELOPE_ENCODE } from '../type';
import type { Engine } from '../engine';
import type { Scope } from '../scope';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import type { EncodeOptions, JSONOf, JSONValue, RuntimeOf } from '../json-type';


/**
 * OptionalType<T> — allows `undefined` in addition to the inner type T.
 * Does NOT expose T's props directly; callers must unwrap (via `.value`
 * or `.or(fallback)`) before accessing inner props. This matches TS's
 * behavior that `T | undefined` can't be dereferenced without narrowing.
 */
export class OptionalType<T = any> extends Type<T | undefined, Record<string, never>> {
  static readonly NAME = 'optional';
  readonly name = OptionalType.NAME;

  static readonly optionKeys = [] as const;
  static readonly genericKeys = ['T'] as const;

  static from(json: TypeDef, scope: TypeScope): OptionalType {
    const registry = scope.registry;
    const inner = json.generic?.T
      ? scope.parse(json.generic.T)
      : registry.any();
    return new OptionalType(scope, inner);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('optional'),
      generic: z.object({ T: opts.Type }).optional(),
    }).meta({ aid: 'Type_optional' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return opts.Expr.optional();
  }

  constructor(scope: TypeScope, readonly inner: Type<T>) {
    super(scope, {}, { T: inner });
  }

  valid(raw: unknown, scope?: TypeScope): raw is RuntimeOf<T | undefined> {
    return raw === undefined || this.inner.valid(raw, scope);
  }

  parse(json: unknown, scope?: TypeScope): Value<T | undefined> {
    if (json === undefined || json === null) return new Value(this, undefined as RuntimeOf<T | undefined>);
    const v = this.inner.parse(json, scope);
    return new Value(this, v.raw as RuntimeOf<T | undefined>);
  }

  /** `optional<fn>` holds a fn, so its value form is the inner one's. */
  parsesExprValue(scope?: TypeScope): boolean {
    return this.inner.parsesExprValue(scope);
  }

  encode(raw: RuntimeOf<T | undefined>, scope?: TypeScope): JSONOf<T | undefined> {
    return this.encodeAs(raw, ENVELOPE_ENCODE, scope) as JSONOf<T | undefined>;
  }

  /** Absence is `null` in JSON under every option; otherwise the inner
   *  type's own walk, so a `optional<list<T>>` still decomposes. */
  encodeAs(raw: RuntimeOf<T | undefined>, opts: EncodeOptions, scope?: TypeScope): unknown {
    if (raw === undefined) return null;
    return this.inner.encodeAs(raw as RuntimeOf<T>, opts, scope);
  }

  /** A `new optional<T>` payload IS a `new T` payload (or nothing), so the
   *  slot walk is the inner type's. Without this an `optional<list<text>>`
   *  slot stopped decomposing and every element inside it reached
   *  `Type.parse` as data. */
  forEachNewSlot(value: unknown, visit: NewSlotVisitor): boolean {
    if (value === undefined || value === null) return false;
    return this.inner.forEachNewSlot(value, visit);
  }

  async newFill(value: unknown, engine: Engine, scope: Scope): Promise<unknown> {
    if (value === undefined || value === null) return value;
    return this.inner.newFill(value, engine, scope);
  }

  create(): RuntimeOf<T | undefined> {
    return undefined as RuntimeOf<T | undefined>;
  }

  random(rnd: Rnd): RuntimeOf<T | undefined> {
    if (rnd(0, 9, true) < 3) return undefined as RuntimeOf<T | undefined>;
    return this.inner.random(rnd) as RuntimeOf<T | undefined>;
  }

  like(other: Type): Type {
    if (!(other instanceof OptionalType)) return this;
    const inner = this.registry.like(other.inner);
    if (inner.name === 'null') return inner;
    return this.registry.optional(inner);
  }

  compatibleType(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (other instanceof OptionalType) {
      return this.inner.compatible(other.inner, opts, scope);
    }
    if (opts?.exact) return false;
    return this.inner.compatible(other, opts, scope);
  }

  or(other: Type<T | undefined>): Type<T | undefined> {
    if (other instanceof OptionalType) {
      return new OptionalType(this.registry, this.inner.or(other.inner as Type<T>));
    }
    return this;
  }

  required(): Type {
    return this.inner;
  }

  isOptional(): boolean {
    return true;
  }

  /** optional<any> (the canonical) delegates compat to `any` — too broad. */
  isUniversal(): boolean {
    return this.inner.isUniversal();
  }

  narrow(local: Partial<Record<string, never>>): Record<string, never> {
    if (local && Object.keys(local).length > 0) {
      throw new TypeError({
        path: [], code: 'optional.no-options',
        message: 'optional has no narrowable options', severity: 'error',
      });
    }
    return {};
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const T = this.inner;
    return {
      ...super.props(),
      value: r.prop(T, 'optional.value'),
      has:   r.method({},                                r.bool(), 'optional.has'),
      or:    r.method({ fallback: T },                   T,        'optional.or'),
      map:   r.method({ fn: r.fn({ args: r.obj({ value: { type: T } }), returns: r.alias('R') }) }, r.optional(r.alias('R')), 'optional.map', { generic: { R: r.any() } }),
    };
  }

  toJSON(): TypeDef {
    return {
      name: OptionalType.NAME,
      generic: { T: this.inner.toJSON() },
    };
  }

  clone(): OptionalType<T> {
    return new OptionalType(this.registry, this.inner.clone() as Type<T>);
  }

  toCode(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + `optional<${this.inner.toCode(undefined, options)}>`;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    return this.describeType(this.inner.toValueSchema(opts).optional(), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return this.describeType(this.inner.toNewSchema(opts).optional(), opts, 'NewValue_');
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('optional'),
      generic: z.object({ T: this.inner.toInstanceSchema() }).optional(),
    }).passthrough();
  }
}
