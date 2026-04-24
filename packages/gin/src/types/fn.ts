import type { Registry } from '../registry';
import type { ExprDef, TypeDef } from '../schema';
import { Value } from '../value';
import { Call, type CompatOptions, type Prop, type Rnd, Type, formatParams, renderGenerics } from '../type';
import { decodeCall, encodeCall } from '../spec';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import { callDefSchema } from '../schemas';

/**
 * FnType — the universal callable. Its shape lives on the `_call` field
 * (exposed via `call()`). Raw values are either a JS function, a lambda
 * ExprDef, or a stringified native reference.
 *
 * `T` is `any` here because a function value is an opaque runtime cell —
 * neither the `RuntimeOf` per-element mapping nor the `JSONOf` envelope
 * shape apply meaningfully to function bodies.
 */
export class FnType extends Type<any, Record<string, never>> {
  static readonly NAME = 'function';
  /** fn's signature IS its structure — call is natively consumed. */
  static readonly consumes = ['call'] as const;
  readonly name = FnType.NAME;

  readonly _call: Call;

  static from(json: TypeDef, registry: Registry): FnType {
    const generic: Record<string, Type> = {};
    if (json.generic) {
      for (const [k, def] of Object.entries(json.generic)) generic[k] = registry.parse(def);
    }
    if (!json.call) {
      return new FnType(registry, new Call({
        args: registry.any() as Type<any>,
        returns: registry.any(),
      }), generic);
    }
    return new FnType(registry, decodeCall(json.call, registry), generic);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('function'),
      call: callDefSchema(opts).optional(),
    }).meta({ aid: 'Type_function' });
  }

  static toNewSchema(_opts: SchemaOptions): z.ZodTypeAny {
    return z.union([
      z.string(),
      z.object({ kind: z.string() }).passthrough(),
    ]);
  }

  constructor(
    registry: Registry,
    call: Call | ConstructorParameters<typeof Call>[0],
    generic: Record<string, Type> = {},
  ) {
    super(registry, {}, generic);
    this._call = call instanceof Call ? call : new Call(call);
  }

  valid(raw: unknown): boolean {
    if (typeof raw === 'function') return true;
    if (typeof raw === 'string') return true;
    if (raw && typeof raw === 'object' && 'kind' in (raw as Record<string, unknown>)) return true;
    return false;
  }

  parse(json: unknown): Value<any> {
    // Functions aren't JSON-serializable; accept either a string ref or an
    // ExprDef (e.g. { kind: 'lambda' }). Native JS functions can only come
    // from in-process construction, not JSON parse.
    if (typeof json === 'string') return new Value(this, json);
    if (json && typeof json === 'object' && 'kind' in (json as Record<string, unknown>)) {
      return new Value(this, json as ExprDef);
    }
    if (typeof json === 'function') return new Value(this, json as any);
    return new Value(this, null as any);
  }

  encode(raw: ((...args: any[]) => any) | ExprDef | string): any {
    if (typeof raw === 'string') return raw;
    if (typeof raw === 'function') return null; // native, not serializable
    return raw;
  }

  create(): any {
    return null;
  }

  random(_rnd: Rnd): any {
    return null;
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (!(other instanceof FnType)) return false;
    // args: contravariant — this.args must accept other.args
    if (!this._call.args.compatible(other._call.args, opts)) return false;
    // returns: covariant — other.returns must be compatible with this.returns
    if (this._call.returns && other._call.returns) {
      if (!this._call.returns.compatible(other._call.returns, opts)) return false;
    }
    return true;
  }

  or(other: Type<any>): Type<any> {
    if (!(other instanceof FnType)) return this;
    return new FnType(this.registry, {
      args: this._call.args.or(other._call.args as Type<any>) as Type<any>,
      returns: this._call.returns && other._call.returns
        ? this._call.returns.or(other._call.returns)
        : this._call.returns ?? other._call.returns,
      throws: this._call.throws && other._call.throws
        ? this._call.throws.or(other._call.throws)
        : this._call.throws ?? other._call.throws,
    });
  }

  narrow(_local: Partial<Record<string, never>>): Record<string, never> {
    return {};
  }

  call(): Call {
    return this._call;
  }

  props(): Record<string, Prop> {
    return super.props() as Record<string, Prop>;
  }

  toJSON(): TypeDef {
    const genericKeys = Object.keys(this.generic);
    const generic = genericKeys.length === 0
      ? undefined
      : Object.fromEntries(genericKeys.map((k) => [k, this.generic[k]!.toJSON()]));
    return {
      name: FnType.NAME,
      call: encodeCall(this._call),
      generic,
    };
  }

  clone(): FnType {
    const genericClone: Record<string, Type> = {};
    for (const [k, t] of Object.entries(this.generic)) genericClone[k] = t.clone();
    return new FnType(
      this.registry,
      {
        args: this._call.args.clone() as Type<any>,
        returns: this._call.returns?.clone(),
        throws: this._call.throws?.clone(),
        get: this._call.get,
        set: this._call.set,
      },
      genericClone,
    );
  }

  toCode(): string {
    const ret = this._call.returns?.toCode() ?? 'void';
    return this.docsPrefix()
      + `${renderGenerics(this.generic)}(${formatParams(this._call.args)}): ${ret}`;
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    // Functions aren't JSON-serializable. Accept a native id (string) or
    // an inline lambda ExprDef (object with `kind`). LLMs shouldn't be
    // generating raw function values — use native id strings.
    return this.describeType(z.union([
      z.string(),
      z.object({ kind: z.string() }).passthrough(),
    ]), opts);
  }
}
