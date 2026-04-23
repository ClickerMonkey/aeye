import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, type Prop, type Rnd, Type } from '../type';
import type { NumOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';


/**
 * NumType — numeric primitive with optional min/max/whole bounds and
 * precision/prefix/suffix for formatting.
 *
 * narrow() enforces directional rules:
 *   local.min   must satisfy local.min   >= base.min
 *   local.max   must satisfy local.max   <= base.max
 *   local.whole: base unset OR local === base
 *   local.minPrecision / maxPrecision: narrow toward fewer allowed digits
 */
export class NumType extends Type<number, NumOptions> {
  static readonly NAME = 'num';
  readonly name = NumType.NAME;

  static from(json: TypeDef, registry: Registry): NumType {
    return new NumType(registry, (json.options ?? {}) as NumOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('num'),
      options: z.object({
        min: z.number().optional(),
        max: z.number().optional(),
        whole: z.boolean().optional(),
        minPrecision: z.number().optional(),
        maxPrecision: z.number().optional(),
        prefix: z.string().optional(),
        suffix: z.string().optional(),
      }).optional(),
    }).meta({ aid: 'Type_num' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.number(); }

  valid(raw: unknown): raw is number {
    if (typeof raw !== 'number' || Number.isNaN(raw)) return false;
    const { min, max, whole } = this.options;
    if (min !== undefined && raw < min) return false;
    if (max !== undefined && raw > max) return false;
    if (whole && !Number.isInteger(raw)) return false;
    return true;
  }

  parse(json: unknown): Value<number> {
    const n = typeof json === 'string' ? Number(json) : json;
    if (typeof n !== 'number' || Number.isNaN(n)) {
      throw new TypeError({
        path: [], code: 'num.invalid',
        message: `num.parse: not a number — ${String(json)}`, severity: 'error',
      });
    }
    if (!this.valid(n)) {
      throw new TypeError({
        path: [], code: 'num.out-of-range',
        message: `num.parse: ${n} violates options ${JSON.stringify(this.options)}`,
        severity: 'error',
      });
    }
    return new Value(this, n);
  }

  encode(raw: number): number {
    return raw;
  }

  create(): number {
    return this.options.min ?? 0;
  }

  random(rnd: Rnd): number {
    const min = this.options.min ?? 0;
    const max = this.options.max ?? 100;
    return rnd(min, max, this.options.whole ?? false);
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (!(other instanceof NumType)) return false;
    if (!opts?.value) return true;
    // value-mode: other's range must fit inside this's range (and whole-compat)
    const a = this.options, b = other.options;
    if (a.min !== undefined && (b.min === undefined || b.min < a.min)) return false;
    if (a.max !== undefined && (b.max === undefined || b.max > a.max)) return false;
    if (a.whole && !b.whole) return false;
    return true;
  }

  or(other: Type<number>): Type<number> {
    if (!(other instanceof NumType)) return this;
    const a = this.options, b = other.options;
    return new NumType(this.registry, {
      min: a.min !== undefined && b.min !== undefined ? Math.min(a.min, b.min) : undefined,
      max: a.max !== undefined && b.max !== undefined ? Math.max(a.max, b.max) : undefined,
      whole: a.whole && b.whole,
      minPrecision: a.minPrecision !== undefined && b.minPrecision !== undefined
        ? Math.min(a.minPrecision, b.minPrecision) : undefined,
      maxPrecision: a.maxPrecision !== undefined && b.maxPrecision !== undefined
        ? Math.max(a.maxPrecision, b.maxPrecision) : undefined,
      prefix: a.prefix === b.prefix ? a.prefix : undefined,
      suffix: a.suffix === b.suffix ? a.suffix : undefined,
    });
  }

  narrow(local: Partial<NumOptions>): NumOptions {
    const base = this.options;
    const fail = (code: string, msg: string): never => {
      throw new TypeError({ path: [], code, message: msg, severity: 'error' });
    };

    const merged: NumOptions = { ...base };

    if (local.min !== undefined) {
      if (base.min !== undefined && local.min < base.min) {
        fail('num.widen.min', `local.min ${local.min} < base.min ${base.min}`);
      }
      merged.min = local.min;
    }
    if (local.max !== undefined) {
      if (base.max !== undefined && local.max > base.max) {
        fail('num.widen.max', `local.max ${local.max} > base.max ${base.max}`);
      }
      merged.max = local.max;
    }
    if (local.whole !== undefined) {
      if (base.whole === true && !local.whole) {
        fail('num.widen.whole', 'base requires whole; local cannot remove');
      }
      merged.whole = local.whole;
    }
    if (local.minPrecision !== undefined) {
      if (base.minPrecision !== undefined && local.minPrecision < base.minPrecision) {
        fail('num.widen.minPrecision', 'minPrecision cannot decrease');
      }
      merged.minPrecision = local.minPrecision;
    }
    if (local.maxPrecision !== undefined) {
      if (base.maxPrecision !== undefined && local.maxPrecision > base.maxPrecision) {
        fail('num.widen.maxPrecision', 'maxPrecision cannot increase');
      }
      merged.maxPrecision = local.maxPrecision;
    }
    if (local.prefix !== undefined) merged.prefix = local.prefix;
    if (local.suffix !== undefined) merged.suffix = local.suffix;

    return merged;
  }

  get(): GetSet {
    // Looping over a number yields |n| iterations. `key` is the 0-based
    // iteration index (always non-negative); `value` walks from 0 toward
    // n by unit steps — so num=10 yields value 0..9, num=-10 yields 0..-9.
    const num = this.registry.num();
    return new GetSet({
      key: this.registry.num({ whole: true, min: 0 }),
      value: num,
      loop: { kind: 'native', id: 'num.loop' },
    });
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num();
    const bool = r.bool();
    const text = r.text();
    const optNum = r.optional(num);
    return {
      // comparison
      eq:  r.method({ other: num, epsilon: optNum }, bool, 'num.eq'),
      neq: r.method({ other: num, epsilon: optNum }, bool, 'num.neq'),
      lt:  r.method({ other: num }, bool, 'num.lt'),
      lte: r.method({ other: num }, bool, 'num.lte'),
      gt:  r.method({ other: num }, bool, 'num.gt'),
      gte: r.method({ other: num }, bool, 'num.gte'),

      // arithmetic
      add: r.method({ other: num }, num, 'num.add'),
      sub: r.method({ other: num }, num, 'num.sub'),
      mul: r.method({ other: num }, num, 'num.mul'),
      div: r.method({ other: num }, num, 'num.div'),
      mod: r.method({ other: num }, num, 'num.mod'),
      pow: r.method({ other: num }, num, 'num.pow'),

      // unary
      abs:  r.method({}, num, 'num.abs'),
      neg:  r.method({}, num, 'num.neg'),
      sign: r.method({}, num, 'num.sign'),
      sqrt: r.method({}, num, 'num.sqrt'),

      // bounds
      min:   r.method({ other: num }, num, 'num.min'),
      max:   r.method({ other: num }, num, 'num.max'),
      clamp: r.method({ min: num, max: num }, num, 'num.clamp'),

      // rounding
      floor: r.method({}, num, 'num.floor'),
      ceil:  r.method({}, num, 'num.ceil'),
      round: r.method({}, num, 'num.round'),

      // predicates
      isZero:     r.method({}, bool, 'num.isZero'),
      isPositive: r.method({}, bool, 'num.isPositive'),
      isNegative: r.method({}, bool, 'num.isNegative'),
      isInteger:  r.method({}, bool, 'num.isInteger'),
      isEven:     r.method({}, bool, 'num.isEven'),
      isOdd:      r.method({}, bool, 'num.isOdd'),

      // conversion
      toText:    r.method({ precision: optNum }, text, 'num.toText'),
      toBoolean: r.method({}, bool, 'num.toBoolean'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: NumType.NAME,
      options: Object.keys(this.options).length > 0 ? { ...this.options } : undefined,
    };
  }

  clone(): NumType {
    return new NumType(this.registry, { ...this.options });
  }

  toCode(): string { return 'number'; }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    let s = this.options.whole ? z.number().int() : z.number();
    if (this.options.min !== undefined) s = s.min(this.options.min);
    if (this.options.max !== undefined) s = s.max(this.options.max);
    return this.describeType(s, opts);
  }

  describe(data: unknown): Type | undefined {
    if (typeof data !== 'number' || Number.isNaN(data)) return undefined;
    return new NumType(this.registry, { whole: Number.isInteger(data) });
  }
}
