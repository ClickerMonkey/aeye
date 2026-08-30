import type { TypeScope } from '../type-scope';
import type { TypeDef } from '../schema';
import type { Registry } from '../registry';
import { Value } from '../value';
import {
  Call,
  type CompatOptions,
  GetSet,
  Prop,
  type PropSpec,
  type Rnd,
  Type,
  indentOf,
  joinAuto,
} from '../type';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import { callDefSchema, getSetDefSchema, propDefSchema } from '../schemas';

/**
 * IfaceType — a structural contract. A type T satisfies this interface
 * when T's public surface (props / get / call) is at least as wide as
 * the interface's declared surface, and signatures are compatible.
 *
 * Props on an interface need only `type` (the signature); `get` provides
 * an optional default implementation satisfying types inherit unless
 * they override.
 */
export class IfaceType extends Type<any, Record<string, never>> {
  static readonly NAME = 'interface';
  /** iface's contract IS its structure — props/get/call are natively consumed. */
  static readonly consumes = ['props', 'get', 'call'] as const;
  readonly name = IfaceType.NAME;

  /** An iface's contract is `props` / `get` / `call` — no options, no generics. */
  static readonly optionKeys = [] as const;
  static readonly genericKeys = [] as const;

  readonly _props: Record<string, Prop>;
  readonly _get?: GetSet;
  readonly _call?: Call;

  static from(json: TypeDef, scope: TypeScope): IfaceType {
    const registry = scope.registry;
    return new IfaceType(scope, {
      props: json.props ? Prop.fromMap(json.props, scope) : {},
      get: json.get ? GetSet.from(json.get, scope) : undefined,
      call: json.call ? Call.from(json.call, scope) : undefined,
    });
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('interface'),
      props: z.record(z.string(), propDefSchema(opts)).optional(),
      get: getSetDefSchema(opts).optional(),
      call: callDefSchema(opts).optional(),
    }).meta({ aid: 'Type_interface' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.record(z.string(), opts.Expr);
  }

  constructor(
    scope: TypeScope,
    spec: { props?: Record<string, Prop | PropSpec>; get?: GetSet; call?: Call },
  ) {
    super(scope, {});
    const p: Record<string, Prop> = {};
    if (spec.props) {
      for (const [k, v] of Object.entries(spec.props)) p[k] = Prop.from(v);
    }
    this._props = p;
    this._get = spec.get;
    this._call = spec.call;
  }

  valid(_raw: unknown, _scope?: TypeScope): _raw is any {
    // Runtime values don't directly "satisfy" interfaces — interface
    // satisfaction is a TYPE-level check (see compatible()).
    return true;
  }

  parse(json: unknown, _scope?: TypeScope): Value<any> {
    return new Value(this, json);
  }

  encode(raw: any, _scope?: TypeScope): any {
    return raw;
  }

  create(): any {
    return null;
  }

  random(_rnd: Rnd): any {
    return null;
  }

  like(other: Type): Type {
    if (!(other instanceof IfaceType)) return this;
    const r = this.registry;
    const narrowedProps: Record<string, PropSpec> = {};
    for (const [name, prop] of Object.entries(other._props)) {
      const t = r.like(prop.type);
      if (t.name === 'null') return r.null();
      narrowedProps[name] = { type: t };
    }
    let narrowedGet: GetSet | undefined;
    if (other._get) {
      const key = r.like(other._get.key);
      const value = r.like(other._get.value);
      if (key.name === 'null' || value.name === 'null') return r.null();
      narrowedGet = new GetSet({ key, value });
    }
    let narrowedCall: Call | undefined;
    if (other._call) {
      const args = r.like(other._call.args);
      if (args.name === 'null') return r.null();
      const returns = other._call.returns ? r.like(other._call.returns) : undefined;
      if (returns && returns.name === 'null') return r.null();
      narrowedCall = new Call({ args: args as Type<any>, returns });
    }
    return new IfaceType(r, {
      props: narrowedProps,
      get: narrowedGet,
      call: narrowedCall,
    });
  }

  compatibleType(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    // "other satisfies this interface" — structural.
    const theirProps = other.props(scope);
    for (const [name, prop] of Object.entries(this._props)) {
      const their = theirProps[name];
      if (!their) return false;
      if (!prop.type.compatible(their.type, opts, scope)) return false;
    }
    if (this._get) {
      const their = other.get(scope);
      if (!their) return false;
      if (!this._get.key.compatible(their.key, opts, scope)) return false;
      if (!this._get.value.compatible(their.value, opts, scope)) return false;
    }
    if (this._call) {
      const their = other.call(scope);
      if (!their) return false;
      if (!this._call.args.compatible(their.args, opts, scope)) return false;
      if (this._call.returns && their.returns) {
        if (!this._call.returns.compatible(their.returns, opts, scope)) return false;
      }
    }
    return true;
  }

  flexible(): boolean {
    return true;
  }

  /** Empty interface (no props / get / call) vacuously matches anything. */
  isUniversal(): boolean {
    return Object.keys(this._props).length === 0 && !this._get && !this._call;
  }

  or(other: Type<any>): Type<any> {
    if (!(other instanceof IfaceType)) return this;
    const merged: Record<string, PropSpec> = {};
    for (const name of Object.keys(this._props)) {
      if (name in other._props) {
        merged[name] = { type: this._props[name]!.type.or(other._props[name]!.type) };
      }
    }
    return new IfaceType(this.registry, { props: merged });
  }

  narrow(_local: Partial<Record<string, never>>): Record<string, never> {
    return {};
  }

  props(scope?: TypeScope): Record<string, Prop> {
    return { ...(super.props(scope) as Record<string, Prop>), ...this._props };
  }

  get(_scope?: TypeScope): GetSet | undefined {
    return this._get;
  }

  call(_scope?: TypeScope): Call | undefined {
    return this._call;
  }

  toJSON(): TypeDef {
    return {
      name: IfaceType.NAME,
      props: Object.keys(this._props).length > 0 ? Prop.toJSONMap(this._props) : undefined,
      get: this._get?.toJSON(),
      call: this._call?.toJSON(),
    };
  }

  clone(): IfaceType {
    const p: Record<string, PropSpec> = {};
    for (const [name, prop] of Object.entries(this._props)) {
      p[name] = { ...prop, type: prop.type.clone() };
    }
    return new IfaceType(this.registry, { props: p, get: this._get, call: this._call });
  }

  toCode(_registry?: Registry, options?: CodeOptions): string {
    const includeComments = options?.includeComments !== false;
    const parts: string[] = [];
    for (const [name, prop] of Object.entries(this._props)) {
      const optional = prop.type.isOptional();
      const t = optional ? prop.type.required() : prop.type;
      const label = optional ? `${name}?` : name;
      const propDocs = prop.docs && includeComments ? `/* ${prop.docs} */ ` : '';
      parts.push(`${propDocs}${label}: ${t.toCode(undefined, options)}`);
    }
    if (this._get) {
      parts.push(`[key: ${this._get.key.toCode(undefined, options)}]: ${this._get.value.toCode(undefined, options)}`);
    }
    if (this._call) {
      const ret = this._call.returns?.toCode(undefined, options) ?? 'void';
      parts.push(`(${this._call.args.toCode(undefined, options)}): ${ret}`);
    }
    const body = parts.length === 0
      ? 'iface'
      : `iface{${joinAuto(parts, { indent: indentOf(options) })}}`;
    return this.docsPrefix(options) + body;
  }

  /** An iface referenced as a base is just `iface` — its contract moves
   *  into the extending type's body. See `Type.toCodeRef`. */
  toCodeRef(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + 'iface';
  }

  /** The three halves of the contract `toCodeRef` elides — an iface's
   *  `toCode` inlines all of props, index signature and call signature,
   *  so all three come back in the extending type's body. */
  refProps(): Record<string, Prop> {
    return this._props;
  }

  refGet(): GetSet | undefined {
    return this._get;
  }

  refCall(): Call | undefined {
    return this._call;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    const mode = opts?.includeDocs ?? 'none';
    // Structural: any object carrying the declared props is acceptable.
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this._props)) {
      let field = prop.type.toValueSchema(opts);
      if (mode === 'all' && prop.docs) field = field.describe(prop.docs);
      shape[name] = field;
    }
    // Passthrough by default — an interface is a contract, and a value that
    // carries MORE than it declares still satisfies it. `unknownKeys:'refuse'`
    // says the payload was authored against this declaration, where an
    // undeclared key is a typo rather than legitimate width.
    return this.describeType(
      opts?.unknownKeys === 'refuse' ? this.valueObject(shape, opts) : z.object(shape).passthrough(),
      opts,
    );
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    const mode = opts.includeDocs ?? 'none';
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this._props)) {
      let slot: z.ZodTypeAny = opts.Expr;
      if (mode === 'all' && prop.docs) slot = slot.describe(prop.docs);
      shape[name] = slot;
    }
    return this.describeType(z.object(shape).passthrough(), opts, 'NewValue_');
  }

  toInstanceSchema(): z.ZodTypeAny {
    const propShape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this._props)) {
      propShape[name] = z.object({ type: prop.type.toInstanceSchema() }).passthrough();
    }
    const shape: Record<string, z.ZodTypeAny> = {
      name: z.literal('iface'),
    };
    if (Object.keys(propShape).length > 0) {
      shape.props = z.object(propShape).optional();
    }
    if (this._get) {
      shape.get = z.object({
        key: this._get.key.toInstanceSchema(),
        value: this._get.value.toInstanceSchema(),
      }).passthrough().optional();
    }
    if (this._call) {
      const callShape: Record<string, z.ZodTypeAny> = { args: this._call.args.toInstanceSchema() };
      if (this._call.returns) callShape.returns = this._call.returns.toInstanceSchema();
      shape.call = z.object(callShape).passthrough().optional();
    }
    return z.object(shape).passthrough();
  }
}
