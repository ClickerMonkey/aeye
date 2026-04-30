import type { TypeScope } from '../type-scope';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type, optionsCode } from '../type';
import type { DateOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions, ValueSchemaOptions } from '../node';


/**
 * DateType — calendar date (year/month/day). Runtime is a JS Date.
 * Serialized as ISO date string (YYYY-MM-DD), trimming time components.
 */
export class DateType extends Type<Date, DateOptions> {
  static readonly NAME = 'date';
  readonly name = DateType.NAME;

  static from(json: TypeDef, scope: TypeScope): DateType {
    const registry = scope.registry;
    return new DateType(scope, (json.options ?? {}) as DateOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('date'),
      options: z.object({
        min: z.string().optional(),
        max: z.string().optional(),
        utc: z.boolean().optional(),
      }).optional(),
    }).meta({ aid: 'Type_date' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'expected ISO 8601 date');
  }

  private boundDate(s: string | undefined): Date | undefined {
    return s ? new Date(s) : undefined;
  }

  valid(raw: unknown): raw is Date {
    if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) return false;
    const min = this.boundDate(this.options.min);
    const max = this.boundDate(this.options.max);
    if (min && raw < min) return false;
    if (max && raw > max) return false;
    return true;
  }

  parse(json: unknown): Value<Date> {
    const d = json instanceof Date ? json : typeof json === 'string' ? new Date(json) : new Date(NaN);
    if (!this.valid(d)) {
      throw new TypeError({
        path: [], code: 'date.invalid',
        message: `date.parse: invalid or out-of-range: ${String(json)}`, severity: 'error',
      });
    }
    return new Value(this, d);
  }

  encode(raw: Date): string {
    return raw.toISOString().slice(0, 10);
  }

  create(): Date {
    return new Date();
  }

  random(rnd: Rnd): Date {
    const min = this.boundDate(this.options.min)?.getTime() ?? Date.UTC(2000, 0, 1);
    const max = this.boundDate(this.options.max)?.getTime() ?? Date.UTC(2050, 11, 31);
    return new Date(rnd(min, max, true));
  }

  compatible(other: Type, _opts?: CompatOptions): boolean {
    return other instanceof DateType;
  }

  or(other: Type<Date>): Type<Date> {
    if (!(other instanceof DateType)) return this;
    const a = this.options, b = other.options;
    return new DateType(this.registry, {
      min: a.min && b.min ? (a.min < b.min ? a.min : b.min) : undefined,
      max: a.max && b.max ? (a.max > b.max ? a.max : b.max) : undefined,
      utc: a.utc === b.utc ? a.utc : undefined,
    });
  }

  narrow(local: Partial<DateOptions>): DateOptions {
    const base = this.options;
    const fail = (code: string, msg: string): never => {
      throw new TypeError({ path: [], code, message: msg, severity: 'error' });
    };
    const merged: DateOptions = { ...base };
    if (local.min !== undefined) {
      if (base.min && local.min < base.min) fail('date.widen.min', 'cannot move min earlier');
      merged.min = local.min;
    }
    if (local.max !== undefined) {
      if (base.max && local.max > base.max) fail('date.widen.max', 'cannot move max later');
      merged.max = local.max;
    }
    if (local.utc !== undefined) merged.utc = local.utc;
    return merged;
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num({ whole: true }), bool = r.bool(), text = r.text(), date = r.date();
    return {
      ...super.props(),
      year:      r.prop(num, 'date.year'),
      month:     r.prop(num, 'date.month'),
      day:       r.prop(num, 'date.day'),
      dayOfWeek: r.prop(num, 'date.dayOfWeek'),
      dayOfYear: r.prop(num, 'date.dayOfYear'),

      eq:     r.method({ other: date }, bool, 'date.eq'),
      neq:    r.method({ other: date }, bool, 'date.neq'),
      before: r.method({ other: date }, bool, 'date.before'),
      after:  r.method({ other: date }, bool, 'date.after'),

      addDays:   r.method({ days: num },   date, 'date.addDays'),
      addMonths: r.method({ months: num }, date, 'date.addMonths'),
      addYears:  r.method({ years: num },  date, 'date.addYears'),

      diffDays:   r.method({ other: date }, num, 'date.diffDays'),
      diffMonths: r.method({ other: date }, num, 'date.diffMonths'),
      diffYears:  r.method({ other: date }, num, 'date.diffYears'),

      toText: r.method({ format: r.optional(text) }, text, 'date.toText'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: DateType.NAME,
      options: Object.keys(this.options).length > 0 ? { ...this.options } : undefined,
    };
  }

  clone(): DateType {
    return new DateType(this.registry, { ...this.options });
  }

  toCode(): string { return this.docsPrefix() + 'date' + optionsCode(this.options); }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Dump form is an ISO date string (YYYY-MM-DD).
    return this.describeType(
      z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'expected ISO 8601 date'),
      opts,
    );
  }

  /** Narrow-match: accept date TypeDef whose bounds are strictly tighter. */
  toInstanceSchema(): z.ZodTypeAny {
    const { min, max } = this.options;
    const hasNarrowing = min !== undefined || max !== undefined;
    const optionsShape: Record<string, z.ZodTypeAny> = {
      min: min === undefined ? z.string().optional() : z.string().refine((v) => v >= min, { message: `min must be >= ${min}` }),
      max: max === undefined ? z.string().optional() : z.string().refine((v) => v <= max, { message: `max must be <= ${max}` }),
      utc: z.boolean().optional(),
    };
    const optionsSchema = z.object(optionsShape);
    return z.object({
      name: z.literal('date'),
      options: hasNarrowing ? optionsSchema : optionsSchema.optional(),
    }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    return data instanceof Date ? this : undefined;
  }
}
