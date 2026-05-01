import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, Init, type Prop, type Rnd, Type } from '../type';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';


/**
 * DurationType — a span of time stored as milliseconds.
 * Runtime: number (ms). Serialized: number.
 * Conceptually extends NumType — shares arithmetic; adds component
 * accessors and a component-based init.
 */
export class DurationType extends Type<number, Record<string, never>> {
  static readonly NAME = 'duration';
  readonly name = DurationType.NAME;

  static from(_json: TypeDef, scope: TypeScope): DurationType {
    const registry = scope.registry;
    return new DurationType(scope, {});
  }

  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.object({ name: z.literal('duration') })
      .meta({ aid: 'Type_duration' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.number(); }

  valid(raw: unknown): raw is number {
    return typeof raw === 'number' && !Number.isNaN(raw);
  }

  parse(json: unknown): Value<number> {
    const n = typeof json === 'number' ? json : Number(json);
    return new Value(this, n);
  }

  encode(raw: number): number {
    return raw;
  }

  create(): number {
    return 0;
  }

  random(rnd: Rnd): number {
    return rnd(0, 1000 * 60 * 60 * 24, true);
  }

  compatible(other: Type, _opts?: CompatOptions): boolean {
    return other instanceof DurationType;
  }

  or(_other: Type<number>): Type<number> {
    return this;
  }

  narrow(_local: Partial<Record<string, never>>): Record<string, never> {
    return {};
  }

  init(): Init {
    const r = this.registry;
    const num = r.num();
    return new Init({
      args: r.obj({
        days:    { type: r.optional(num) },
        hours:   { type: r.optional(num) },
        minutes: { type: r.optional(num) },
        seconds: { type: r.optional(num) },
        ms:      { type: r.optional(num) },
      }) as Type<any>,
      run: { kind: 'native', id: 'duration.init' },
    });
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    const num = r.num({ whole: true });
    const text = r.text();
    return {
      ...super.props(),
      totalSeconds: r.prop(r.num(),     'duration.totalSeconds'),
      totalMinutes: r.prop(r.num(),     'duration.totalMinutes'),
      totalHours:   r.prop(r.num(),     'duration.totalHours'),
      totalDays:    r.prop(r.num(),     'duration.totalDays'),

      days:    r.prop(num, 'duration.days'),
      hours:   r.prop(num, 'duration.hours'),
      minutes: r.prop(num, 'duration.minutes'),
      seconds: r.prop(num, 'duration.seconds'),
      ms:      r.prop(num, 'duration.ms'),

      toText: r.method({ format: r.optional(text) }, text, 'duration.toText'),
    };
  }

  toJSON(): TypeDef {
    return { name: DurationType.NAME };
  }

  clone(): DurationType {
    return new DurationType(this.registry, {});
  }

  toCode(_registry?: Registry, options?: CodeOptions): string { return this.docsPrefix(options) + 'duration'; }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Dump form is a number of milliseconds.
    return this.describeType(z.number(), opts);
  }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({ name: z.literal('duration') }).passthrough();
  }
}
