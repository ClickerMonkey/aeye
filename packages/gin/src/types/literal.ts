import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type PropSpec, type Rnd, Type, optionsCode } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions, ValueSchemaOptions } from '../node';
import type { JSONOf, RuntimeOf } from '../json-type';


export interface LiteralOptions<T = unknown> {
  value: T;
}

/**
 * LiteralType<T> — a type whose only valid value is one specific constant.
 *
 * Stores:
 *  - `inner` (in generic.T)       — the base type (text, num, bool, …)
 *  - `value` (in options.value)   — the literal constant that all instances equal
 *
 * Useful for:
 *  - Unions of literals as enum-like constraints (`"red" | "green" | "blue"`)
 *  - Tagged-union discriminants
 *  - Indexed-access key types (e.g. obj's get() uses `or(literals)` over field names)
 *
 * Compatibility: a LiteralType<T>(v) accepts another LiteralType<T>(v) only
 * when the literal values are equal. In non-exact mode it also accepts any
 * value of the inner type (since the literal IS a value of the inner type).
 */
export class LiteralType<T = unknown> extends Type<T, LiteralOptions<T>> {
  static readonly NAME = 'literal';
  readonly name = LiteralType.NAME;

  readonly inner: Type<T>;

  static from(json: TypeDef, registry: Registry): LiteralType {
    const inner = json.generic?.T ? registry.parse(json.generic.T) : registry.any();
    const value = (json.options as { value?: unknown } | undefined)?.value;
    return new LiteralType(registry, inner, value);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('literal'),
      generic: z.object({ T: opts.Type }).optional(),
      options: z.object({ value: z.any() }),
    }).meta({ aid: 'Type_literal' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny {
    // The exact literal lives in the instance — at class level we accept
    // any primitive and let runtime parse reject mismatches.
    return z.any();
  }

  constructor(registry: Registry, inner: Type<T>, value: T) {
    super(registry, { value }, { T: inner });
    this.inner = inner;
  }

  get literal(): T {
    return this.options.value;
  }

  valid(raw: unknown): raw is RuntimeOf<T> {
    return this.inner.valid(raw) && raw === this.literal;
  }

  parse(json: unknown): Value<T> {
    const inner = this.inner.parse(json);
    if (inner.raw !== this.literal) {
      throw new TypeError({
        path: [], code: 'literal.not-match',
        message: `literal: expected ${String(this.literal)}, got ${String(inner.raw)}`,
        severity: 'error',
      });
    }
    return new Value(this, inner.raw);
  }

  encode(raw: RuntimeOf<T>): JSONOf<T> {
    return this.inner.encode(raw);
  }

  create(): RuntimeOf<T> {
    return this.literal as RuntimeOf<T>;
  }

  random(_rnd: Rnd): RuntimeOf<T> {
    return this.literal as RuntimeOf<T>;
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (other instanceof LiteralType) {
      return this.inner.compatible(other.inner, opts) && this.literal === other.literal;
    }
    if (opts?.exact) return false;
    // Literal is compatible with its inner type (a literal IS a value of inner).
    return this.inner.compatible(other, opts);
  }

  /** literal<any> (canonical with no declared value) delegates to any — too broad. */
  isUniversal(): boolean {
    return this.inner.isUniversal();
  }

  or(other: Type<T>): Type<T> {
    if (other instanceof LiteralType && other.literal === this.literal) return this;
    // Different literal values would widen to an Or — callers explicitly
    // build that via registry.or([a, b]); same-class merge isn't meaningful here.
    return this;
  }

  narrow(local: Partial<LiteralOptions<T>>): LiteralOptions<T> {
    if (local.value !== undefined && local.value !== this.literal) {
      throw new TypeError({
        path: [], code: 'literal.narrow',
        message: 'literal value cannot change via narrow', severity: 'error',
      });
    }
    return this.options;
  }

  /** Literals inherit the inner type's props so ops like eq, lt, toText work. */
  props(): Record<string, Prop | PropSpec> {
    return this.inner.props();
  }

  toJSON(): TypeDef {
    return {
      name: LiteralType.NAME,
      generic: { T: this.inner.toJSON() },
      options: { value: this.literal },
    };
  }

  clone(): LiteralType<T> {
    return new LiteralType(this.registry, this.inner.clone() as Type<T>, this.literal);
  }

  toCode(): string {
    return this.docsPrefix() + `literal<${this.inner.toCode()}>`
      + optionsCode({ value: this.literal });
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    return this.describeType(
      z.literal(this.literal as string | number | boolean | null),
      opts,
    );
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({
      name: z.literal('literal'),
      options: z.object({
        value: z.literal(this.literal as string | number | boolean | null),
      }),
      generic: z.object({ T: this.inner.toInstanceSchema() }).optional(),
    }).passthrough();
  }
}
