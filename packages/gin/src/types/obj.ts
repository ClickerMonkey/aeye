import type { Registry } from '../registry';
import type { TypeDef, PropDef } from '../schema';
import { Value } from '../value';
import { type CompatOptions, GetSet, Prop, type PropSpec, type Rnd, Type } from '../type';
import { decodeProps, encodeProps } from '../spec';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { SchemaOptions } from '../node';
import type { JSONOf, JSONValue, RuntimeOf } from '../json-type';
import { propDefSchema } from '../schemas';

/**
 * ObjType — structural object with named fields (props). Unlike other
 * types, ObjType's defining structure lives IN its props: fields are
 * exposed via props() directly. Any number of fields, typed per-name.
 */
export class ObjType<T extends object = Record<string, any>> extends Type<T, Record<string, never>> {
  static readonly NAME = 'object';
  /** obj's fields ARE its structure — props is natively consumed. */
  static readonly consumes = ['props'] as const;
  readonly name = ObjType.NAME;

  /** Runtime prop specs. Structural fields — each has at least `type`. */
  readonly fields: Record<string, Prop>;

  static from(json: TypeDef, registry: Registry): ObjType {
    const fieldDefs = (json.props ?? {}) as Record<string, PropDef>;
    const fields = decodeProps(fieldDefs, registry);
    return new ObjType(registry, fields);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('object'),
      props: z.record(z.string(), propDefSchema(opts)).optional(),
    }).meta({ aid: 'Type_object' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Class-level: `Record<string, Expr>` — any field name / Expr value.
    // Registered named objs narrow to a `z.object({per-field})` shape.
    return z.record(z.string(), opts.Expr);
  }

  constructor(registry: Registry, fields: Record<string, Prop | PropSpec>) {
    super(registry, {});
    // Normalize plain objects to Prop instances so methods are available.
    const normalized: Record<string, Prop> = {};
    for (const [k, v] of Object.entries(fields)) {
      normalized[k] = Prop.from(v);
    }
    this.fields = normalized;
  }

  valid(raw: unknown): raw is RuntimeOf<T> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    for (const [name] of Object.entries(this.fields)) {
      const v = (raw as Record<string, unknown>)[name];
      // Each field stores a Value; the Value's type may be a subtype of
      // the declared field type. Validate the stored raw against the
      // Value's actual type (supports covariance).
      if (!(v instanceof Value)) return false;
      if (!v.type.valid(v.raw)) return false;
    }
    return true;
  }

  parse(json: unknown): Value<T> {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new TypeError({
        path: [], code: 'object.invalid',
        message: `object.parse: expected object, got ${typeof json}`, severity: 'error',
      });
    }
    const raw: Record<string, Value> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      const input = (json as Record<string, unknown>)[name];
      raw[name] = this.registry.parseValue(input, prop.type);
    }
    return new Value(this, raw as RuntimeOf<T>);
  }

  /** Each field becomes a `JSONValue` envelope. */
  encode(raw: RuntimeOf<T>): JSONOf<T> {
    const fields = raw as Record<string, Value>;
    const out: Record<string, JSONValue> = {};
    for (const [name] of Object.entries(this.fields)) {
      const v = fields[name];
      if (v) out[name] = v.toJSON();
    }
    return out as JSONOf<T>;
  }

  create(): RuntimeOf<T> {
    const out: Record<string, Value> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      out[name] = new Value(prop.type, prop.type.create());
    }
    return out as RuntimeOf<T>;
  }

  random(rnd: Rnd): RuntimeOf<T> {
    const out: Record<string, Value> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      out[name] = new Value(prop.type, prop.type.random(rnd));
    }
    return out as RuntimeOf<T>;
  }

  like(other: Type): Type {
    if (!(other instanceof ObjType)) return this;
    const narrowed: Record<string, PropSpec> = {};
    for (const [name, prop] of Object.entries(other.fields)) {
      const t = this.registry.like(prop.type);
      if (t.name === 'null') return this.registry.null();
      narrowed[name] = { type: t };
    }
    return this.registry.obj(narrowed);
  }

  compatible(other: Type, opts?: CompatOptions): boolean {
    if (!(other instanceof ObjType)) return false;
    // Structural: every field in this must appear compatibly in other.
    for (const [name, prop] of Object.entries(this.fields)) {
      const otherProp = other.fields[name];
      if (!otherProp) return false;
      if (!prop.type.compatible(otherProp.type, opts)) return false;
    }
    // In exact mode, field sets must match.
    if (opts?.exact) {
      const mine = new Set(Object.keys(this.fields));
      for (const n of Object.keys(other.fields)) if (!mine.has(n)) return false;
    }
    return true;
  }

  or(other: Type<T>): Type<T> {
    if (!(other instanceof ObjType)) return this;
    // Widen: intersection of names (only fields present in both); per-name
    // type = or of both. Fields in only one side are dropped (they're not
    // guaranteed for all values).
    const merged: Record<string, PropSpec> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      const b = (other.fields as Record<string, Prop>)[name];
      if (b) merged[name] = { type: prop.type.or(b.type) };
    }
    return new ObjType(this.registry, merged);
  }

  narrow(_local: Partial<Record<string, never>>): Record<string, never> {
    return {};
  }

  props(): Record<string, Prop | PropSpec> {
    const r = this.registry;
    const fieldTypes = Object.values(this.fields).map((p) => p.type);
    const V = fieldTypes.length === 0
      ? r.any()
      : fieldTypes.length === 1 ? fieldTypes[0]! : r.or(fieldTypes);
    const meta: Record<string, Prop> = {
      keys:    r.method({}, r.list(r.text()),          'object.keys'),
      values:  r.method({}, r.list(V),                 'object.values'),
      entries: r.method({}, r.list(r.tuple([r.text(), V])), 'object.entries'),
      has:     r.method({ key: r.text() },             r.bool(), 'object.has'),
      eq:      r.method({ other: r.any() },            r.bool(), 'object.eq'),
      neq:     r.method({ other: r.any() },            r.bool(), 'object.neq'),
      toText:  r.method({},                            r.text(), 'object.toText'),
    };
    // Declared fields win over meta-methods if the names collide.
    return { ...super.props(), ...meta, ...this.fields };
  }

  get(): GetSet | undefined {
    const names = Object.keys(this.fields);
    if (names.length === 0) return undefined;
    // Key is `or(literal("name1"), literal("name2"), …)` — a union of
    // literal field-name constants, constraining indexed access to known
    // fields only. Value is the union of all field types.
    const text = this.registry.text();
    const keyLiterals = names.map((n) => this.registry.literal(text, n));
    const key = keyLiterals.length === 1 ? keyLiterals[0]! : this.registry.or(keyLiterals);
    const fieldTypes = Object.values(this.fields).map((p) => p.type);
    const value = fieldTypes.length === 1 ? fieldTypes[0]! : this.registry.or(fieldTypes);
    return new GetSet({
      key,
      value,
      get: { kind: 'native', id: 'object.indexGet' },
      set: { kind: 'native', id: 'object.indexSet' },
      loop: { kind: 'native', id: 'object.iterate' },
    });
  }

  toJSON(): TypeDef {
    return {
      name: ObjType.NAME,
      props: encodeProps(this.fields),
    };
  }

  clone(): ObjType<T> {
    const cloned: Record<string, PropSpec> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      cloned[name] = { ...prop, type: prop.type.clone() };
    }
    return new ObjType<T>(this.registry, cloned);
  }

  toCode(): string {
    const entries = Object.entries(this.fields);
    if (entries.length === 0) return this.docsPrefix() + 'obj';
    const parts = entries.map(([name, prop]) => {
      const optional = prop.type.isOptional();
      const t = optional ? prop.type.required() : prop.type;
      const label = optional ? `${name}?` : name;
      const propDocs = prop.docs ? `/* ${prop.docs} */ ` : '';
      return `${propDocs}${label}: ${t.toCode()}`;
    });
    return this.docsPrefix() + `obj{${parts.join(', ')}}`;
  }

  toValueSchema(opts?: SchemaOptions): z.ZodTypeAny {
    const mode = opts?.includeDocs ?? 'none';
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      let field = prop.type.toValueSchema(opts);
      if (mode === 'all' && prop.docs) field = field.describe(prop.docs);
      shape[name] = field;
    }
    return this.describeType(z.object(shape), opts);
  }

  toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    const mode = opts.includeDocs ?? 'none';
    // Each field accepts any Expr — Get, NewExpr, function-call path, etc.
    // Per-field type correctness is enforced at evaluate/validate time.
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      let slot: z.ZodTypeAny = opts.Expr;
      if (mode === 'all' && prop.docs) slot = slot.describe(prop.docs);
      shape[name] = prop.type.isOptional() ? slot.optional() : slot;
    }
    return this.describeType(z.object(shape), opts, 'NewValue_');
  }

  toInstanceSchema(): z.ZodTypeAny {
    const propShape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      propShape[name] = z.object({ type: prop.type.toInstanceSchema() }).passthrough();
    }
    return z.object({
      name: z.literal('object'),
      props: z.object(propShape).optional(),
    }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const fields: Record<string, PropSpec> = {};
    for (const [name, value] of Object.entries(data)) {
      // Fall back to any — deeper inference is the describer's job, not ours.
      const inferred = (this.registry.any() as Type).describe?.(value) ?? this.registry.any();
      fields[name] = { type: inferred };
    }
    return new ObjType(this.registry, fields);
  }
}
