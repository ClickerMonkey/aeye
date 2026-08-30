import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, type Prop, type Rnd, Type, optionsCode } from '../type';
import type { NumOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';


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

  static readonly optionKeys = [
    'min', 'max', 'whole', 'minPrecision', 'maxPrecision', 'prefix', 'suffix',
  ] as const satisfies readonly (keyof NumOptions)[];
  static readonly genericKeys = [] as const;

  static from(json: TypeDef, scope: TypeScope): NumType {
    const registry = scope.registry;
    return new NumType(scope, (json.options ?? {}) as NumOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('num'),
      options: z.object({
        min: z.number().optional().describe('Only set when a real lower bound is part of the spec — e.g. "positive count" → min: 1, "age" → min: 0. Do NOT add `min: 0` to every num just because most numbers happen to be non-negative.'),
        max: z.number().optional().describe('Only set when there is an actual upper bound — a percentage capped at 100, a year capped at 9999. Do NOT pick a generic ceiling like 1000/9999 to fill the field.'),
        whole: z.boolean().optional().describe('Only set to true when the value is genuinely integral (counts, indices, ids). Leave unset (allow fractions) for measurements, ratios, etc.'),
        minPrecision: z.number().optional().describe('Decimal-place floor. Almost never needed; omit unless the spec explicitly requires N decimal places.'),
        maxPrecision: z.number().optional().describe('Decimal-place ceiling. Same rule as minPrecision — omit unless explicitly required.'),
        prefix: z.string().optional().describe('Display-only prefix (e.g. "$"). Has no effect on validation. Omit unless rendering needs it.'),
        suffix: z.string().optional().describe('Display-only suffix (e.g. "%"). Same as prefix — omit unless rendering needs it.'),
      }).optional().describe('Omit entirely for ordinary numbers. Only include when the value has a real, named constraint worth enforcing on every parse.'),
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

  /**
   * Zero, CLAMPED into the declared range — a type's constructor must not
   * produce a value its own `parse` refuses. `num{max:-3}.create()` used to be
   * `0`, which the type then rejected as out of range. A contradictory range
   * (`min > max`) is uninhabitable, so the result there is best-effort.
   */
  create(): number {
    const { min, max, whole } = this.options;
    let n = 0;
    if (min !== undefined && n < min) n = min;
    if (max !== undefined && n > max) n = max;
    if (whole && !Number.isInteger(n)) {
      // Round INTO the range: up, unless that would break `max`.
      const up = Math.ceil(n);
      n = max !== undefined && up > max ? Math.floor(n) : up;
    }
    return n;
  }

  random(rnd: Rnd): number {
    const min = this.options.min ?? 0;
    const max = this.options.max ?? 100;
    return rnd(min, max, this.options.whole ?? false);
  }

  compatibleType(other: Type, opts?: CompatOptions): boolean {
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
    const r = this.registry;
    return new GetSet({
      key: r.num({ whole: true, min: 0 }),
      value: r.num(),
      loop: r.nativeExpr('num.loop'),
    });
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num();
    const bool = r.bool();
    const text = r.text();
    const optNum = r.optional(num);
    return {
      ...super.props(),
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
      toBool: r.method({}, bool, 'num.toBool'),
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

  toCode(_registry?: Registry, options?: CodeOptions): string {
    // `minPrecision` / `maxPrecision` / `prefix` / `suffix` are
    // display-only — skip when at their typical defaults so the
    // type code stays focused on validation-relevant constraints
    // (`min`, `max`, `whole`).
    return this.docsPrefix(options) + 'num' + optionsCode(this.options, {
      minPrecision: 1,
      maxPrecision: 7,
      prefix: '',
      suffix: '',
    });
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    let s = this.options.whole ? z.number().int() : z.number();
    if (this.options.min !== undefined) s = s.min(this.options.min);
    if (this.options.max !== undefined) s = s.max(this.options.max);
    return this.describeType(s, opts);
  }

  /** Narrow-match: accept a num TypeDef whose options are strictly tighter
   *  than this one's (higher min, lower max, whole if this demands whole).
   *  When `this` has any narrowing set, the incoming TypeDef MUST carry
   *  options satisfying those narrowings — a plain `{name:'num'}` is looser,
   *  so it's rejected. */
  toInstanceSchema(): z.ZodTypeAny {
    const { min, max, whole } = this.options;
    const hasNarrowing = min !== undefined || max !== undefined || whole === true;
    const optionsShape: Record<string, z.ZodTypeAny> = {
      min:          min === undefined   ? z.number().optional()  : z.number().gte(min),
      max:          max === undefined   ? z.number().optional()  : z.number().lte(max),
      whole:        whole ? z.literal(true) : z.boolean().optional(),
      minPrecision: z.number().optional(),
      maxPrecision: z.number().optional(),
      prefix:       z.string().optional(),
      suffix:       z.string().optional(),
    };
    const optionsSchema = z.object(optionsShape);
    return z.object({
      name: z.literal('num'),
      options: hasNarrowing ? optionsSchema : optionsSchema.optional(),
    }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    if (typeof data !== 'number' || Number.isNaN(data)) return undefined;
    return new NumType(this.registry, { whole: Number.isInteger(data) });
  }
}
