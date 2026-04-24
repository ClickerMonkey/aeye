import type { Registry } from '../registry';
import type { TypeDef } from '../schema';
import { Value } from '../value';
import {
  type Call,
  type CompatOptions,
  type GetSet,
  Prop,
  type PropSpec,
  type Rnd,
  Type,
} from '../type';
import { decodeCall, decodeGetSet, decodeProps, encodeCall, encodeGetSet, encodeProps } from '../spec';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
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

  readonly _props: Record<string, Prop>;
  readonly _get?: GetSet;
  readonly _call?: Call;

  static from(json: TypeDef, registry: Registry): IfaceType {
    return new IfaceType(registry, {
      props: json.props ? decodeProps(json.props, registry) : {},
      get: json.get ? decodeGetSet(json.get, registry) : undefined,
      call: json.call ? decodeCall(json.call, registry) : undefined,
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
    registry: Registry,
    spec: { props?: Record<string, Prop | PropSpec>; get?: GetSet; call?: Call },
  ) {
    super(registry, {});
    const p: Record<string, Prop> = {};
    if (spec.props) {
      for (const [k, v] of Object.entries(spec.props)) p[k] = Prop.from(v);
    }
    this._props = p;
    this._get = spec.get;
    this._call = spec.call;
  }

  valid(_raw: unknown): _raw is any {
    // Runtime values don't directly "satisfy" interfaces — interface
    // satisfaction is a TYPE-level check (see compatible()).
    return true;
  }

  parse(json: unknown): Value<any> {
    return new Value(this, json);
  }

  encode(raw: any): any {
    return raw;
  }

  create(): any {
    return null;
  }

  random(_rnd: Rnd): any {
    return null;
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    // "other satisfies this interface" — structural.
    const theirProps = other.props();
    for (const [name, prop] of Object.entries(this._props)) {
      const their = theirProps[name];
      if (!their) return false;
      if (!prop.type.compatible(their.type, opts)) return false;
    }
    if (this._get) {
      const their = other.get();
      if (!their) return false;
      if (!this._get.key.compatible(their.key, opts)) return false;
      if (!this._get.value.compatible(their.value, opts)) return false;
    }
    if (this._call) {
      const their = other.call();
      if (!their) return false;
      if (!this._call.args.compatible(their.args, opts)) return false;
      if (this._call.returns && their.returns) {
        if (!this._call.returns.compatible(their.returns, opts)) return false;
      }
    }
    return true;
  }

  flexible(): boolean {
    return true;
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

  props(): Record<string, Prop> {
    return { ...(super.props() as Record<string, Prop>), ...this._props };
  }

  get(): GetSet | undefined {
    return this._get;
  }

  call(): Call | undefined {
    return this._call;
  }

  toJSON(): TypeDef {
    return {
      name: IfaceType.NAME,
      props: Object.keys(this._props).length > 0 ? encodeProps(this._props) : undefined,
      get: this._get ? encodeGetSet(this._get) : undefined,
      call: this._call ? encodeCall(this._call) : undefined,
    };
  }

  clone(): IfaceType {
    const p: Record<string, PropSpec> = {};
    for (const [name, prop] of Object.entries(this._props)) {
      p[name] = { ...prop, type: prop.type.clone() };
    }
    return new IfaceType(this.registry, { props: p, get: this._get, call: this._call });
  }

  toCode(): string {
    const parts: string[] = [];
    for (const [name, prop] of Object.entries(this._props)) {
      const optional = prop.type.isOptional();
      const t = optional ? prop.type.required() : prop.type;
      const label = optional ? `${name}?` : name;
      const propDocs = prop.docs ? `/* ${prop.docs} */ ` : '';
      parts.push(`${propDocs}${label}: ${t.toCode()}`);
    }
    if (this._get) {
      parts.push(`[key: ${this._get.key.toCode()}]: ${this._get.value.toCode()}`);
    }
    if (this._call) {
      const ret = this._call.returns?.toCode() ?? 'void';
      parts.push(`(${this._call.args.toCode()}): ${ret}`);
    }
    const body = parts.length === 0 ? 'iface' : `iface{${parts.join(', ')}}`;
    return this.docsPrefix() + body;
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    const mode = opts?.includeDocs ?? 'none';
    // Structural: any object carrying the declared props is acceptable.
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this._props)) {
      let field = prop.type.toValueSchema(opts);
      if (mode === 'all' && prop.docs) field = field.describe(prop.docs);
      shape[name] = field;
    }
    return this.describeType(z.object(shape).passthrough(), opts);
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
}
