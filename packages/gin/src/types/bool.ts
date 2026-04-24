import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type, optionsCode } from '../type';
import type { BoolOptions } from '../builder';
import { z } from 'zod';
import type { SchemaOptions } from '../node';


/**
 * BoolType — boolean primitive. Options carry optional text aliases
 * used when serializing to/from text.
 */
export class BoolType extends Type<boolean, BoolOptions> {
  static readonly NAME = 'bool';
  readonly name = BoolType.NAME;

  static from(json: TypeDef, registry: Registry): BoolType {
    return new BoolType(registry, (json.options ?? {}) as BoolOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('bool'),
      options: z.object({
        trueText: z.string().optional(),
        falseText: z.string().optional(),
      }).optional(),
    }).meta({ aid: 'Type_bool' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.boolean(); }

  valid(raw: unknown): raw is boolean {
    return typeof raw === 'boolean';
  }

  parse(json: unknown): Value<boolean> {
    if (typeof json === 'boolean') return new Value(this, json);
    if (json === this.options.trueText) return new Value(this, true);
    if (json === this.options.falseText) return new Value(this, false);
    throw new Error(`bool.parse: expected boolean, got ${typeof json}`);
  }

  encode(raw: boolean): boolean {
    return raw;
  }

  create(): boolean {
    return false;
  }

  random(rnd: Rnd): boolean {
    return rnd(0, 1, true) === 1;
  }

  compatible(other: Type, _opts?: CompatOptions): boolean {
    return other instanceof BoolType;
  }

  or(other: Type<boolean>): Type<boolean> {
    if (!(other instanceof BoolType)) return this;
    // Aliases from either side merge; narrower side wins on conflict.
    return new BoolType(this.registry, {
      trueText: this.options.trueText ?? other.options.trueText,
      falseText: this.options.falseText ?? other.options.falseText,
    });
  }

  narrow(local: Partial<BoolOptions>): BoolOptions {
    // Text aliases are free to set/replace — they're orthogonal constraints
    // (no directional narrowing applies). Local wins.
    return { ...this.options, ...local };
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    return {
      ...super.props(),
      eq:        r.method({ other: r.bool() }, r.bool(), 'bool.eq'),
      neq:       r.method({ other: r.bool() }, r.bool(), 'bool.neq'),
      and:       r.method({ other: r.bool() }, r.bool(), 'bool.and'),
      or:        r.method({ other: r.bool() }, r.bool(), 'bool.or'),
      xor:       r.method({ other: r.bool() }, r.bool(), 'bool.xor'),
      not:       r.method({},                  r.bool(), 'bool.not'),
      toText:    r.method({},                  r.text(), 'bool.toText'),
      toNum:  r.method({},                  r.num(),  'bool.toNum'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: BoolType.NAME,
      options: Object.keys(this.options).length > 0 ? { ...this.options } : undefined,
    };
  }

  clone(): BoolType {
    return new BoolType(this.registry, { ...this.options });
  }

  toCode(): string { return this.docsPrefix() + 'bool' + optionsCode(this.options); }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny { return this.describeType(z.boolean(), opts); }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({ name: z.literal('bool') }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    return typeof data === 'boolean' ? this : undefined;
  }
}
