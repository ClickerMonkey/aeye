import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, type Prop, type Rnd, Type } from '../type';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions, ValueSchemaOptions } from '../node';


/**
 * VoidType — the unit type used as the return of side-effecting functions.
 * Its only value is `undefined`.
 */
export class VoidType extends Type<void, Record<string, never>> {
  static readonly NAME = 'void';
  readonly name = VoidType.NAME;

  static from(_json: TypeDef, registry: Registry): VoidType {
    return new VoidType(registry, {});
  }

  static toSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.object({ name: z.literal('void') })
      .meta({ aid: 'Type_void' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny { return z.null(); }

  valid(raw: unknown): raw is void {
    return raw === undefined;
  }

  parse(json: unknown): Value<void> {
    if (json !== undefined && json !== null) {
      throw new TypeError({
        path: [], code: 'void.invalid',
        message: `void expects undefined/null, got ${typeof json}`, severity: 'error',
      });
    }
    return new Value<void>(this, undefined);
  }

  encode(_raw: void): null {
    return null;
  }

  create(): void {
    return undefined;
  }

  random(_rnd: Rnd): void {
    return undefined;
  }

  compatible(other: Type, _opts?: CompatOptions): boolean {
    return other instanceof VoidType;
  }

  or(_other: Type<void>): Type<void> {
    return this;
  }

  narrow(local: Partial<Record<string, never>>): Record<string, never> {
    if (local && Object.keys(local).length > 0) {
      throw new TypeError({
        path: [], code: 'void.no-options',
        message: 'void has no narrowable options', severity: 'error',
      });
    }
    return {};
  }

  props(): Record<string, Prop> {
    const r = this.registry;
    return {
      ...super.props(),
      toText:    r.method({}, r.text(), 'void.toText'),
      toBool: r.method({}, r.bool(), 'void.toBool'),
    };
  }

  toJSON(): TypeDef {
    return { name: VoidType.NAME };
  }

  clone(): VoidType {
    return new VoidType(this.registry, {});
  }

  toCode(): string { return this.docsPrefix() + 'void'; }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny { return this.describeType(z.null(), opts); }

  toInstanceSchema(): z.ZodTypeAny {
    return z.object({ name: z.literal('void') }).passthrough();
  }
}
