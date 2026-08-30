import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type, optionsCode } from '../type';
import type { TimestampOptions } from '../builder';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';


/**
 * TimestampType — a precise point in time. Runtime is a JS Date;
 * serialized as ISO 8601 with time components (UTC by default).
 *
 * Conceptually extends DateType — shares calendar operations but adds
 * time-of-day and duration arithmetic. This POC implements it standalone;
 * an Extension<Date> is a valid alternative refactor.
 */
export class TimestampType extends Type<Date, TimestampOptions> {
  static readonly NAME = 'timestamp';
  readonly name = TimestampType.NAME;

  static readonly optionKeys = ['min', 'max', 'utc', 'precision'] as const satisfies readonly (keyof TimestampOptions)[];
  static readonly genericKeys = [] as const;

  static from(json: TypeDef, scope: TypeScope): TimestampType {
    const registry = scope.registry;
    return new TimestampType(scope, (json.options ?? {}) as TimestampOptions);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('timestamp'),
      options: z.object({
        min: z.string().optional(),
        max: z.string().optional(),
        utc: z.boolean().optional(),
        precision: z.enum(['ms', 's', 'us']).optional(),
      }).optional(),
    }).meta({ aid: 'Type_timestamp' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.string().regex(
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
      'expected ISO 8601 timestamp',
    );
  }

  valid(raw: unknown): raw is Date {
    return raw instanceof Date && !Number.isNaN(raw.getTime());
  }

  parse(json: unknown): Value<Date> {
    const d = json instanceof Date ? json : typeof json === 'string' ? new Date(json) : new Date(NaN);
    if (!this.valid(d)) {
      throw new TypeError({
        path: [], code: 'timestamp.invalid',
        message: `timestamp.parse: invalid: ${String(json)}`, severity: 'error',
      });
    }
    return new Value(this, d);
  }

  encode(raw: Date): string {
    return raw.toISOString();
  }

  create(): Date {
    return new Date();
  }

  random(rnd: Rnd): Date {
    return new Date(rnd(Date.UTC(2000, 0, 1), Date.UTC(2050, 11, 31), true));
  }

  compatibleType(other: Type, _opts?: CompatOptions): boolean {
    return other instanceof TimestampType;
  }

  or(other: Type<Date>): Type<Date> {
    return other instanceof TimestampType ? this : this;
  }

  narrow(_local: Partial<TimestampOptions>): TimestampOptions {
    return this.options;
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num({ whole: true }), bool = r.bool(), text = r.text();
    const ts = r.timestamp(), duration = r.duration();
    return {
      ...super.props(),
      year:        r.prop(num, 'timestamp.year'),
      month:       r.prop(num, 'timestamp.month'),
      day:         r.prop(num, 'timestamp.day'),
      hour:        r.prop(num, 'timestamp.hour'),
      minute:      r.prop(num, 'timestamp.minute'),
      second:      r.prop(num, 'timestamp.second'),
      millisecond: r.prop(num, 'timestamp.millisecond'),

      eq:     r.method({ other: ts }, bool, 'timestamp.eq'),
      before: r.method({ other: ts }, bool, 'timestamp.before'),
      after:  r.method({ other: ts }, bool, 'timestamp.after'),

      addDuration: r.method({ duration }, ts, 'timestamp.addDuration'),
      subDuration: r.method({ duration }, ts, 'timestamp.subDuration'),
      diff:        r.method({ other: ts }, duration, 'timestamp.diff'),

      toDate:  r.method({}, r.date(), 'timestamp.toDate'),
      toEpoch: r.method({}, num, 'timestamp.toEpoch'),
      toText:  r.method({ format: r.optional(text) }, text, 'timestamp.toText'),
    };
  }

  toJSON(): TypeDef {
    return {
      name: TimestampType.NAME,
      options: Object.keys(this.options).length > 0 ? { ...this.options } : undefined,
    };
  }

  clone(): TimestampType {
    return new TimestampType(this.registry, { ...this.options });
  }

  toCode(_registry?: Registry, options?: CodeOptions): string { return this.docsPrefix(options) + 'timestamp' + optionsCode(this.options); }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Dump form is ISO 8601 datetime with a REQUIRED time component:
    //   YYYY-MM-DD[T or space]HH:MM[:SS[.fff]][Z|±HH:MM]
    return this.describeType(z.string().regex(
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/,
      'expected ISO 8601 timestamp',
    ), opts);
  }

  toInstanceSchema(): z.ZodTypeAny {
    const { min, max, precision } = this.options;
    const hasNarrowing = min !== undefined || max !== undefined || precision !== undefined;
    const optionsShape: Record<string, z.ZodTypeAny> = {
      min: min === undefined ? z.string().optional() : z.string().refine((v) => v >= min, { message: `min must be >= ${min}` }),
      max: max === undefined ? z.string().optional() : z.string().refine((v) => v <= max, { message: `max must be <= ${max}` }),
      utc: z.boolean().optional(),
      precision: precision === undefined ? z.enum(['ms', 's', 'us']).optional() : z.literal(precision),
    };
    const optionsSchema = z.object(optionsShape);
    return z.object({
      name: z.literal('timestamp'),
      options: hasNarrowing ? optionsSchema : optionsSchema.optional(),
    }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    return data instanceof Date ? this : undefined;
  }
}
