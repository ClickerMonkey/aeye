import type { TypeScope } from '../type-scope';
import type { Registry } from '../registry';
import type { TypeDef, PropDef } from '../schema';
import { Value } from '../value';
import {
  type CompatOptions, GetSet, type NewSlotVisitor, Prop, type PropSpec, type Rnd, Type,
  ENVELOPE_ENCODE, embeddedExpr, encodeSlot, indentOf, isRecordPayload, joinAuto, slotAccepts,
} from '../type';
import type { Engine } from '../engine';
import type { Scope } from '../scope';
import { TypeError } from '../problem';
import { z } from 'zod';
import type { CodeOptions, SchemaOptions, ValueSchemaOptions } from '../node';
import type { EncodeOptions, JSONOf, RuntimeOf } from '../json-type';
import { propDefSchema } from '../schemas';

/**
 * ObjType — structural object with named fields (props). Unlike other
 * types, ObjType's defining structure lives IN its props: fields are
 * exposed via props() directly. Any number of fields, typed per-name.
 */
export class ObjType<T extends object = Record<string, any>> extends Type<T, Record<string, never>> {
  static readonly NAME = 'obj';
  /** obj's fields ARE its structure — props is natively consumed. */
  static readonly consumes = ['props'] as const;
  readonly name = ObjType.NAME;

  /** An obj's fields are its `props` — it takes no options and no generics. */
  static readonly optionKeys = [] as const;
  static readonly genericKeys = [] as const;

  /** Runtime prop specs. Structural fields — each has at least `type`. */
  readonly fields: Record<string, Prop>;

  static from(json: TypeDef, scope: TypeScope): ObjType {
    const fields = Prop.fromMap(json.props ?? {}, scope);
    return new ObjType(scope, fields);
  }

  static toSchema(opts: SchemaOptions): z.ZodTypeAny {
    return z.object({
      name: z.literal('obj'),
      props: z.record(z.string(), propDefSchema(opts)).optional(),
    }).meta({ aid: 'Type_object' });
  }

  static toNewSchema(opts: SchemaOptions): z.ZodTypeAny {
    // Class-level: `Record<string, Expr>` — any field name / Expr value.
    // Registered named objs narrow to a `z.object({per-field})` shape.
    return z.record(z.string(), opts.Expr);
  }

  constructor(scope: TypeScope, fields: Record<string, Prop | PropSpec>) {
    super(scope, {});
    // Normalize plain objects to Prop instances so methods are available.
    const normalized: Record<string, Prop> = {};
    for (const [k, v] of Object.entries(fields)) {
      normalized[k] = Prop.from(v);
    }
    this.fields = normalized;
  }

  valid(raw: unknown, scope?: TypeScope): raw is RuntimeOf<T> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
    for (const [name, prop] of Object.entries(this.fields)) {
      const v = (raw as Record<string, unknown>)[name];
      // Each field stores a Value whose type may be a SUBTYPE of the
      // declared field type, so the stored raw is validated against the
      // Value's actual type (covariance) — and, since 0.4.1, that actual
      // type must itself be one the declared field accepts. Without the
      // second half a `num` landed in a `text` field and `valid` said yes.
      if (!(v instanceof Value)) return false;
      if (!v.type.valid(v.raw, scope)) return false;
      if (!slotAccepts(prop.type, v.type, scope)) return false;
    }
    return true;
  }

  parse(json: unknown, scope?: TypeScope): Value<T> {
    if (typeof json !== 'object' || json === null || Array.isArray(json)) {
      throw new TypeError({
        path: [], code: 'object.invalid',
        message: `object.parse: expected object, got ${typeof json}`, severity: 'error',
      });
    }
    const raw: Record<string, Value> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      const input = (json as Record<string, unknown>)[name];
      raw[name] = this.registry.parseValue(input, prop.type, scope);
    }
    return new Value(this, raw as RuntimeOf<T>);
  }

  /** Each field becomes a `JSONValue` envelope — or its bare logical form
   *  under `form:'logical'`. One walk, via `encodeAs`. */
  encode(raw: RuntimeOf<T>, scope?: TypeScope): JSONOf<T> {
    return this.encodeAs(raw, ENVELOPE_ENCODE, scope) as JSONOf<T>;
  }

  encodeAs(raw: RuntimeOf<T>, opts: EncodeOptions, scope?: TypeScope): unknown {
    const fields = raw as Record<string, Value>;
    const out: Record<string, unknown> = {};
    for (const [name] of Object.entries(this.fields)) {
      const v = fields[name];
      if (v) out[name] = encodeSlot(v, opts, scope);
    }
    return out;
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

  /**
   * A `new obj` payload is a FIELD MAP: each declared field is a slot with
   * the field's own declared type, and a declared field the payload omits
   * contributes the `default` Expr the runtime will fill it with.
   *
   * Not decomposed when the payload is itself an Expr threaded into the
   * value slot whole (`{kind:'get', path:[…]}` where an obj literal would
   * go). The probe is the `kind` key naming a registered Expr class, which
   * is ambiguous with an obj that DECLARES a field called `kind` — the
   * ambiguity is inherent to the wire form (an ExprDef and an obj payload
   * are both bare JSON objects) and is resolved the same way at every
   * consumer, which is the most that can be done from here.
   */
  forEachNewSlot(value: unknown, visit: NewSlotVisitor): boolean {
    if (!isFieldMap(value) || embeddedExpr(value, this.scope)) return false;
    const obj = value as Record<string, unknown>;
    for (const [name, prop] of Object.entries(this.fields)) {
      if (name in obj) visit.slot(prop.type, obj[name], name);
      else if (prop.default !== undefined) visit.missing?.(prop.default, name);
    }
    return true;
  }

  async newFill(value: unknown, engine: Engine, scope: Scope): Promise<unknown> {
    if (!isFieldMap(value) || embeddedExpr(value, this.scope)) {
      return super.newFill(value, engine, scope);
    }
    const input = value as Record<string, unknown>;
    let filled: Record<string, unknown> | undefined;
    // Sequential, in declaration order — see `Type.newFill`.
    for (const [name, prop] of Object.entries(this.fields)) {
      if (name in input) {
        const next = await prop.type.newFill(input[name], engine, scope);
        if (next !== input[name]) {
          filled ??= { ...input };
          filled[name] = next;
        }
      } else if (prop.default !== undefined) {
        filled ??= { ...input };
        filled[name] = await prop.default.evaluate(engine, scope);
      }
    }
    return filled ?? input;
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

  compatible(other: Type, opts?: CompatOptions, scope?: TypeScope): boolean {
    if (!(other instanceof ObjType)) return false;
    // Structural: `this` accepts every value of `other`. Each field
    // declared on `this` either appears on `other` with a compatible
    // type (covariant per-field), or — when `this`'s field is optional
    // — may be absent on `other` (an optional field doesn't constrain
    // values that lack it). The latter is what makes
    // `{x:num, y?:bool}.compatible({x:num})` true: callers passing the
    // simpler shape still produce values the wider shape accepts.
    for (const [name, prop] of Object.entries(this.fields)) {
      const otherProp = other.fields[name];
      if (!otherProp) {
        if (opts?.exact) return false;
        if (prop.type.isOptional()) continue;
        return false;
      }
      if (!prop.type.compatible(otherProp.type, opts, scope)) return false;
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
    const r = this.registry;
    return new GetSet({
      key,
      value,
      get: r.nativeExpr('object.indexGet'),
      set: r.nativeExpr('object.indexSet'),
      loop: r.nativeExpr('object.iterate'),
    });
  }

  toJSON(): TypeDef {
    return {
      name: ObjType.NAME,
      props: Prop.toJSONMap(this.fields),
    };
  }

  clone(): ObjType<T> {
    const cloned: Record<string, PropSpec> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      cloned[name] = { ...prop, type: prop.type.clone() };
    }
    return new ObjType<T>(this.registry, cloned);
  }

  toCode(_registry?: Registry, options?: CodeOptions): string {
    const entries = Object.entries(this.fields);
    if (entries.length === 0) return this.docsPrefix(options) + 'obj';
    const includeComments = options?.includeComments !== false;
    const parts = entries.map(([name, prop]) => {
      const optional = prop.type.isOptional();
      const t = optional ? prop.type.required() : prop.type;
      const label = optional ? `${name}?` : name;
      const propDocs = prop.docs && includeComments ? `/* ${prop.docs} */ ` : '';
      return `${propDocs}${label}: ${t.toCode(undefined, options)}`;
    });
    // `joinAuto`, not `Array.join` — every other delimited renderer in the
    // library (`renderGenerics`, `formatParams`, `optionsCode`) already
    // wraps at length, so a plain join here meant a method's arguments
    // wrapped while the obj they returned did not, inside one rendered
    // block, from one library. An obj was the only delimited form that
    // never wrapped at ANY length (the envelope below ran to 233 chars).
    return this.docsPrefix(options)
      + `obj{${joinAuto(parts, { indent: indentOf(options) })}}`;
  }

  /** An obj referenced as a base is just `obj` — its fields move into the
   *  extending type's body rather than onto its header line. See
   *  `Type.toCodeRef`. */
  toCodeRef(_registry?: Registry, options?: CodeOptions): string {
    return this.docsPrefix(options) + 'obj';
  }

  /** The fields `toCodeRef` elides. An obj's fields ARE its structure. */
  refProps(): Record<string, Prop> {
    return this.fields;
  }

  toValueSchema(opts?: ValueSchemaOptions): z.ZodTypeAny {
    const mode = opts?.includeDocs ?? 'none';
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [name, prop] of Object.entries(this.fields)) {
      let field = prop.type.toValueSchema(opts);
      if (mode === 'all' && prop.docs) field = field.describe(prop.docs);
      shape[name] = field;
    }
    return this.describeType(this.valueObject(shape, opts), opts);
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
      name: z.literal('obj'),
      props: z.object(propShape).optional(),
    }).passthrough();
  }

  describe(data: unknown): Type | undefined {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return undefined;
    const fields: Record<string, PropSpec> = {};
    for (const [name, value] of Object.entries(data)) {
      // Fall back to any — deeper inference is the describer's job, not ours.
      const inferred = this.registry.any().describe?.(value) ?? this.registry.any();
      fields[name] = { type: inferred };
    }
    return new ObjType(this.registry, fields);
  }
}

/** A `new obj` payload shape. `isRecordPayload` is the canonical predicate —
 *  in particular it excludes a `Value`, which is a BUILT value and never a
 *  payload awaiting construction. */
function isFieldMap(value: unknown): value is Record<string, unknown> {
  return isRecordPayload(value);
}
