/**
 * Gin → `a`. Gin types generate `a` schemas instead of zod.
 *
 * In the real migration this lives in @aeye/gin as `Type.toA()` next to
 * (then replacing) `Type.toValueSchema()`; here it works on the TypeDef JSON
 * (structurally the same `TypeDef` gin serializes) so this package needs no gin
 * build. Two halves:
 *
 * - TYPE level: `GinSchema<T>` maps a `const` TypeDef literal to the exact
 *   `a` class, so `a.infer` of a converted gin type is the gin type's code
 *   shape (`fromGin({name:'list', generic:{V:{name:'num'}}})` → `ArrayType<NumberType>`).
 * - RUNTIME: `fromGin(def)` builds it; a named (registered) gin type becomes
 *   `a.ref(name)`; `ginNamedTypes(registry)` turns a registry's named types
 *   into the defs a chain's dynamic step returns.
 *
 * Every kind accepts exactly what gin's `toValueSchema` accepts (checked
 * value-for-value against @aeye/gin in corpus/gin-values.test.ts), with two
 * deliberate differences:
 * - `map<text, V>` is a RECORD in the code shape. The pairs encoding is the
 *   profile's job (`[{key, value}]` only where the dialect forbids an open
 *   `additionalProperties`); gin's runtime reads a record. `map<K, V>` with a
 *   non-text key stays pairs in the code shape too (JSON has no non-string keys).
 * - Named types are refs into `$defs`, not `z.lazy` + `aid` meta.
 */
import {
  AnyType, ArrayType, BooleanType, EnumType, IntersectionType, LiteralType, NotType, NullType, NullableType, NumberType, ObjectType,
  OptionalType, RecordType, RefType, StringType, TupleType, UnionType, type AnySchema, type LiteralValue, type SchemaOf,
} from '../schema';

/** Structurally gin's `TypeDef` (packages/gin/src/schema.ts). */
export interface GinTypeDef {
  readonly name: string;
  readonly docs?: string;
  /** A registered type's definition: the type it extends (`{name: 'Task', extends: 'obj', props}`). */
  readonly extends?: string;
  readonly generic?: { readonly [key: string]: GinTypeDef };
  readonly options?: { readonly [key: string]: unknown };
  readonly props?: { readonly [key: string]: { readonly type: GinTypeDef; readonly docs?: string; readonly get?: unknown } };
  /** A runtime predicate every value must satisfy (a gin ExprDef). */
  readonly constraint?: unknown;
}

type Props<P> = { [K in keyof P]: P[K] extends { readonly type: infer T } ? GinSchema<T> : never };

/** The `a` classes of a tuple of gin TypeDefs. */
type GinParts<O extends readonly unknown[]> = O extends readonly [infer H, ...infer R] ? [GinSchema<H>, ...GinParts<R>] : [];

type EnumOf<U> = [U] extends [string] ? EnumType<[U, ...U[]]> : SchemaOf<U>;

/** The `a` class for a gin TypeDef literal. Unknown names are named types → refs; a non-literal def is any schema. */
export type GinSchema<T> =
  T extends { readonly name: infer N } ? (string extends N ? AnySchema : GinKnown<T>) : AnySchema;

type GinKnown<T> =
  T extends { readonly name: 'text' } ? StringType
  : T extends { readonly name: 'num' } ? NumberType
  : T extends { readonly name: 'bool' } ? BooleanType
  : T extends { readonly name: 'null' | 'void' } ? NullType
  : T extends { readonly name: 'any' } ? AnyType<unknown>
  : T extends { readonly name: 'date' | 'timestamp' } ? StringType
  // gin dumps a duration as milliseconds and a color as a 32-bit integer
  : T extends { readonly name: 'duration' | 'color' } ? NumberType
  : T extends { readonly name: 'list'; readonly generic: { readonly V: infer V } } ? ArrayType<GinSchema<V>>
  : T extends { readonly name: 'map'; readonly generic: { readonly V: infer V; readonly K: { readonly name: 'text' } } } ? RecordType<GinSchema<V>>
  : T extends { readonly name: 'map'; readonly generic: { readonly V: infer V; readonly K: infer K } } ? ArrayType<ObjectType<{ key: GinSchema<K>; value: GinSchema<V> }>>
  : T extends { readonly name: 'map'; readonly generic: { readonly V: infer V } } ? RecordType<GinSchema<V>>
  : T extends { readonly name: 'optional'; readonly generic: { readonly T: infer I } } ? OptionalType<GinSchema<I>>
  : T extends { readonly name: 'nullable'; readonly generic: { readonly T: infer I } } ? NullableType<GinSchema<I>>
  : T extends { readonly name: 'obj'; readonly props: infer P } ? ObjectType<Props<P>>
  : T extends { readonly name: 'enum'; readonly options: { readonly values: infer V } } ? EnumOf<V[keyof V]>
  : T extends { readonly name: 'literal'; readonly options: { readonly value: infer V extends LiteralValue } } ? LiteralType<V>
  : T extends { readonly name: 'or'; readonly options: { readonly types: infer O extends readonly unknown[] } } ? UnionType<{ [I in keyof O]: GinSchema<O[I]> } & [AnySchema, ...AnySchema[]]>
  : T extends { readonly name: 'tuple'; readonly options: { readonly elements: infer O extends readonly unknown[] } }
    ? (GinParts<O> extends infer P extends readonly [AnySchema, ...AnySchema[]] ? TupleType<P> : AnySchema)
  : T extends { readonly name: 'and'; readonly options: { readonly types: infer O extends readonly unknown[] } }
    ? (GinParts<O> extends infer P extends readonly [AnySchema, ...AnySchema[]] ? IntersectionType<P> : AnyType<unknown>)
  : T extends { readonly name: 'not'; readonly options: { readonly excluded: unknown } } ? NotType<AnyType<unknown>>
  : T extends { readonly name: 'interface' | 'iface'; readonly props: infer P } ? ObjectType<Props<P>>
  : T extends { readonly name: 'interface' | 'iface' } ? ObjectType<{}>
  : T extends { readonly name: 'typ' } ? RefType<'TypeDef'>
  : T extends { readonly name: 'fn' } ? RefType<'Expr'>
  : T extends { readonly name: infer N extends string } ? RefType<N>
  : AnySchema;

/** Gin type names with their own `a` mapping; anything else is a named (registered) type. */
export const GIN_BUILTINS = new Set([
  'text', 'num', 'bool', 'null', 'void', 'any', 'date', 'timestamp', 'duration', 'color',
  'list', 'map', 'optional', 'nullable', 'obj', 'enum', 'literal', 'or', 'tuple', 'typ', 'fn',
  'and', 'not', 'iface', 'interface',
]);

/** gin types/date.ts: an ISO date PREFIX (a datetime passes too). */
const GIN_DATE = '^\\d{4}-\\d{2}-\\d{2}';
/** gin types/timestamp.ts: a required time part, optional seconds/fraction/zone. */
const GIN_TIMESTAMP = '^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(:\\d{2}(\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})?$';

export interface FromGinOptions {
  /**
   * The registry's named types. With it, a GENERIC named type used with
   * arguments (`{name: 'Box', generic: {T: num}}`) is instantiated in place
   * (its generic parameters replaced by the arguments). Without it, a named
   * type is always a ref.
   */
  readonly named?: ReadonlyMap<string, GinTypeDef>;
}

/** Convert one gin TypeDef. */
export function fromGin<const T extends GinTypeDef>(def: T, opts?: FromGinOptions): GinSchema<T>;
export function fromGin(def: GinTypeDef, opts: FromGinOptions = {}): AnySchema {
  let s = def.extends ? convertDefinition(def, opts) : convert(def, opts);
  const parts = [def.docs, def.constraint !== undefined ? `Each value must satisfy this gin constraint: ${JSON.stringify(def.constraint)}` : undefined].filter(Boolean);
  if (parts.length) s = s.describe(parts.join('\n'));
  return s;
}

/** A prop gin stores in the value (not a computed `get`, not a method). */
const stored = (p: { readonly type: GinTypeDef; readonly get?: unknown }) => !p.get && p.type.name !== 'fn';

function propsShape(props: GinTypeDef['props'], opts: FromGinOptions): Record<string, AnySchema> {
  const shape: Record<string, AnySchema> = {};
  for (const [k, p] of Object.entries(props ?? {})) {
    if (!stored(p)) continue;
    let s = fromGin(p.type, opts);
    if (p.docs) s = s.describe(p.docs);
    shape[k] = s;
  }
  return shape;
}

/**
 * A registered type's DEFINITION (`{name: 'Task', extends: 'obj', props}`,
 * extension.ts): the base with the stored local props added.
 */
function convertDefinition(def: GinTypeDef, opts: FromGinOptions): AnySchema {
  const { name: _n, extends: base, props, docs: _d, constraint: _c, ...rest } = def;
  const local = propsShape(props, opts);
  if (base === 'obj' || base === 'interface' || base === 'iface') return new ObjectType(local);
  const b = convert({ ...rest, name: base! }, opts);
  if (!Object.keys(local).length) return b;
  return new IntersectionType([b, new ObjectType(local)]);
}

/** Replace a generic template's parameters (`{name: 'T'}`) by the arguments. */
function substitute(def: GinTypeDef, args: Readonly<Record<string, GinTypeDef>>): GinTypeDef {
  if (!def.generic && !def.props && !def.options && def.name in args) return args[def.name]!;
  const sub = (d: GinTypeDef) => substitute(d, args);
  return {
    ...def,
    ...(def.generic ? { generic: Object.fromEntries(Object.entries(def.generic).map(([k, v]) => [k, sub(v)])) } : {}),
    ...(def.props ? { props: Object.fromEntries(Object.entries(def.props).map(([k, p]) => [k, { ...p, type: sub(p.type) }])) } : {}),
    ...(def.options && Array.isArray((def.options as { types?: unknown }).types)
      ? { options: { ...def.options, types: ((def.options as { types: GinTypeDef[] }).types).map(sub) } } : {}),
  };
}

function convert(def: GinTypeDef, opts: FromGinOptions): AnySchema {
  const o = (def.options ?? {}) as Record<string, any>;
  const g = def.generic ?? {};
  const sub = (d: GinTypeDef) => fromGin(d, opts);
  switch (def.name) {
    case 'text': {
      let s = new StringType();
      if (typeof o.minLength === 'number') s = s.min(o.minLength);
      if (typeof o.maxLength === 'number') s = s.max(o.maxLength);
      if (typeof o.pattern === 'string') s = s.pattern(o.pattern, typeof o.flags === 'string' ? o.flags : undefined);
      return s;
    }
    case 'num': {
      let s = new NumberType({ int: !!o.whole });
      if (typeof o.min === 'number') s = s.min(o.min);
      if (typeof o.max === 'number') s = s.max(o.max);
      return s;
    }
    case 'bool': return new BooleanType();
    case 'null':
    case 'void': return new NullType();
    case 'any': return new AnyType();
    case 'date': return new StringType().pattern(GIN_DATE).describe('An ISO 8601 date (YYYY-MM-DD).');
    case 'timestamp': return new StringType().pattern(GIN_TIMESTAMP).describe('An ISO 8601 timestamp (YYYY-MM-DD HH:MM[:SS][Z]).');
    case 'duration': return new NumberType().describe('A duration in milliseconds.');
    case 'color': return new NumberType({ int: true }).min(0).max(0xffffffff).describe(o.hasAlpha ? 'A color as a 32-bit integer 0xRRGGBBAA.' : 'A color as an integer 0xRRGGBB.');
    case 'list': {
      let s = new ArrayType(g.V ? sub(g.V) : new AnyType());
      if (typeof o.minLength === 'number') s = s.min(o.minLength);
      if (typeof o.maxLength === 'number') s = s.max(o.maxLength);
      return s;
    }
    case 'map': {
      const V = g.V ? sub(g.V) : new AnyType();
      if (!g.K || g.K.name === 'text') return new RecordType(V);
      return new ArrayType(new ObjectType({ key: sub(g.K), value: V }));
    }
    case 'optional': return new OptionalType(g.T ? sub(g.T) : new AnyType());
    case 'nullable': return new NullableType(g.T ? sub(g.T) : new AnyType());
    case 'obj': return new ObjectType(propsShape(def.props, opts));
    case 'enum': {
      const values = Object.values((o.values ?? {}) as Record<string, unknown>);
      if (values.length && values.every((v) => typeof v === 'string')) return new EnumType(values as [string, ...string[]]);
      return new UnionType(values.map((v) => new LiteralType(v as LiteralValue)) as unknown as [AnySchema, ...AnySchema[]]);
    }
    case 'literal': return new LiteralType(o.value as LiteralValue);
    case 'or': return new UnionType(((o.types ?? []) as GinTypeDef[]).map(sub) as unknown as [AnySchema, ...AnySchema[]]);
    // gin types/tuple.ts serializes `options.elements` (older defs: `types`).
    case 'tuple': return new TupleType(((o.elements ?? o.types ?? []) as GinTypeDef[]).map(sub) as unknown as [AnySchema, ...AnySchema[]]);
    // A value that IS a gin type / program: a ref into the grammar module (see corpus/gin-grammar.ts).
    case 'typ': return new RefType('TypeDef');
    case 'fn': return new RefType('Expr');
    // An intersection: objects merge into one object (every dialect can say
    // that), anything else is validated after the first part.
    case 'and': {
      const parts = ((o.types ?? []) as GinTypeDef[]).map(sub);
      return parts.length === 0 ? new AnyType() : parts.length === 1 ? parts[0]! : new IntersectionType(parts as unknown as [AnySchema, ...AnySchema[]]);
    }
    // Any value except the excluded type: said in words, checked on decode.
    case 'not': return new NotType(o.excluded ? sub(o.excluded as GinTypeDef) : new AnyType(), new AnyType());
    // A structural contract: an object with at least these props (wider values still satisfy it, as in gin).
    case 'interface':
    case 'iface': return new ObjectType(propsShape(def.props, opts));
    default: {
      // A generic named type used with arguments: instantiated in place when the registry is known.
      const template = opts.named?.get(def.name);
      if (template && def.generic && Object.keys(def.generic).length) {
        return fromGin(substitute(template.extends ? { ...template, name: def.name } : template, def.generic), opts);
      }
      return new RefType(def.name);
    }
  }
}

/** A gin registry, structurally: its named types as TypeDefs. */
export interface GinRegistryLike {
  readonly version: number;
  named(): ReadonlyMap<string, GinTypeDef>;
}

/**
 * The registry's named types as `a` defs — what a chain's dynamic step
 * returns. A registry's names are runtime data, so the caller states the
 * ones its code relies on and their TS types (`T`); `Bound` checks at bind
 * time that they exist. Every other registered name comes along untyped.
 *
 * Both serializations work: a structural def under its name
 * (`Task → {name: 'obj', props}`) and gin's own extension form
 * (`{name: 'Task', extends: 'obj', props}`, `Type.toJSON()`). A generic
 * named type's parameters stand for their declared bounds in its own
 * definition; uses with arguments are instantiated.
 */
export function ginNamedTypes<T extends Record<string, unknown> = {}>(
  registry: GinRegistryLike,
): { readonly [K in keyof T]: SchemaOf<T[K]> } & Record<string, AnySchema> {
  const named = registry.named();
  const out: Record<string, AnySchema> = {};
  for (const [name, def] of named) {
    // In its own definition, a generic parameter is its bound (`T: any` → any).
    const body = def.generic && !def.extends ? substitute({ ...def, generic: undefined as never }, def.generic) : def;
    const { generic: _g, ...plain } = body;
    out[name] = fromGin((def.generic && !def.extends ? plain : body) as GinTypeDef, { named });
  }
  return out as { readonly [K in keyof T]: SchemaOf<T[K]> } & Record<string, AnySchema>;
}
