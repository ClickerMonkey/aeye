import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions, ValueSchemaOptions } from '../node';
import type { JSONOf, JSONValue, RuntimeOf } from '../json-type';


/**
 * OptionalType<T> — allows `undefined` in addition to the inner type T.
 * Does NOT expose T's props directly; callers must unwrap (via `.value`
 * or `.or(fallback)`) before accessing inner props. This matches TS's
 * behavior that `T | undefined` can't be dereferenced without narrowing.
 */
export class OptionalType<T = any> extends Type<T | undefined, Record<string, never>> {
  static readonly NAME = 'optional';
  readonly name = OptionalType.NAME;

  static from(json: TypeDef, registry: Registry): OptionalType {
    const inner = json.generic?.T
      ? registry.parse(json.generic.T)
      : registry.any();
    return new OptionalType(registry, inner);
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

  constructor(registry: Registry, readonly inner: Type<T>) {
    super(registry, {}, { T: inner });
  }

  valid(raw: unknown): raw is RuntimeOf<T | undefined> {
    return raw === undefined || this.inner.valid(raw);
  }

  parse(json: unknown): Value<T | undefined> {
    if (json === undefined || json === null) return new Value(this, undefined as RuntimeOf<T | undefined>);
    const v = this.inner.parse(json);
    return new Value(this, v.raw as RuntimeOf<T | undefined>);
  }

  encode(raw: RuntimeOf<T | undefined>): JSONOf<T | undefined> {
    if (raw === undefined) return null as JSONOf<T | undefined>;
    return this.inner.encode(raw as RuntimeOf<T>) as JSONOf<T | undefined>;
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

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (other instanceof OptionalType) {
      return this.inner.compatible(other.inner, opts);
    }
    if (opts?.exact) return false;
    return this.inner.compatible(other, opts);
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
      map:   r.method({ fn: r.fn(r.obj({ value: { type: T } }), r.generic('R')) }, r.optional(r.generic('R')), 'optional.map', { generic: { R: r.any() } }),
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

  toCode(): string {
    return this.docsPrefix() + `optional<${this.inner.toCode()}>`;
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
