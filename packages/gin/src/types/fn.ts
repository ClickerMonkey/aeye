import type { ExprDef, TypeDef } from '../schema';
import { Value } from '../value';
import { Call, type CompatOptions, type Prop, type Rnd, Type, formatParams, renderCallTypes, renderGenerics } from '../type';
import { decodeCall } from '../spec';
import { LocalScope, type TypeScope } from '../type-scope';
import { z } from 'zod';
import type { SchemaOptions, ValueSchemaOptions } from '../node';
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

  static from(json: TypeDef, scope: TypeScope): FnType {
    const registry = scope.registry;
    // Generics declared on the fn — bind each into a LocalScope so that
    // bare `{name: 'T'}` inside the call signature resolves to the
    // generic placeholder via AliasType (and supports later
    // substitution via .bind).
    const generic: Record<string, Type> = {};
    const local = new LocalScope(scope);
    if (json.generic) {
      for (const [k, def] of Object.entries(json.generic)) {
        const t = local.parse(def);
        generic[k] = t;
        local.bind(k, t);
      }
    }
    if (!json.call) {
      return new FnType(local, new Call({
        args: registry.any() as Type<any>,
        returns: registry.any(),
      }), generic);
    }
    return new FnType(local, decodeCall(json.call, local), generic);
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
    scope: TypeScope,
    call: Call | ConstructorParameters<typeof Call>[0],
    generic: Record<string, Type> = {},
  ) {
    super(scope, {}, generic);
    this._call = call instanceof Call ? call : new Call(call);
  }

  valid(raw: unknown, _scope?: TypeScope): boolean {
    if (typeof raw === 'function') return true;
    if (typeof raw === 'string') return true;
    if (raw && typeof raw === 'object' && 'kind' in (raw as Record<string, unknown>)) return true;
    return false;
  }

  parse(json: unknown, _scope?: TypeScope): Value<any> {
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

  encode(raw: ((...args: any[]) => any) | ExprDef | string, _scope?: TypeScope): any {
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

  like(other: Type): Type {
    if (!(other instanceof FnType)) return this;
    const r = this.registry;
    const args = r.like(other._call.args);
    if (args.name === 'null') return r.null();
    const returns = other._call.returns ? r.like(other._call.returns) : undefined;
    if (returns && returns.name === 'null') return r.null();
    const throws = other._call.throws ? r.like(other._call.throws) : undefined;
    if (throws && throws.name === 'null') return r.null();
    return r.fn(args as Type<any>, returns, throws, this.generic);
  }

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (!(other instanceof FnType)) return false;
    // args: contravariant — this.args must accept other.args
    if (!this._call.args.compatible(other._call.args, opts, scope)) return false;
    // returns: covariant — other.returns must be compatible with this.returns
    if (this._call.returns && other._call.returns) {
      if (!this._call.returns.compatible(other._call.returns, opts, scope)) return false;
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

  call(_scope?: TypeScope): Call {
    return this._call;
  }

  props(scope?: TypeScope): Record<string, Prop> {
    return super.props(scope) as Record<string, Prop>;
  }

  toJSON(): TypeDef {
    const genericKeys = Object.keys(this.generic);
    const generic = genericKeys.length === 0
      ? undefined
      : Object.fromEntries(genericKeys.map((k) => [k, this.generic[k]!.toJSON()]));
    return {
      name: FnType.NAME,
      call: this._call.toJSON(),
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
      + `${renderGenerics(this.generic)}${renderCallTypes(this._call.types)}(${formatParams(this._call.args)}): ${ret}`;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    // Functions aren't JSON-serializable. Accept a native id (string) or
    // an inline lambda ExprDef (object with `kind`). LLMs shouldn't be
    // generating raw function values — use native id strings.
    return this.describeType(z.union([
      z.string(),
      z.object({ kind: z.string() }).passthrough(),
    ]), opts);
  }

  toInstanceSchema(): z.ZodTypeAny {
    const callShape: Record<string, z.ZodTypeAny> = {
      args: this._call.args.toInstanceSchema(),
    };
    if (this._call.returns) callShape.returns = this._call.returns.toInstanceSchema();
    if (this._call.throws) callShape.throws = this._call.throws.toInstanceSchema();
    return z.object({
      name: z.literal('fn'),
      call: z.object(callShape).passthrough(),
    }).passthrough();
  }
}
