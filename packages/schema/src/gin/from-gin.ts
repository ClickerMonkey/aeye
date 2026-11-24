/**
 * Gin → `a`. Gin types generate `a` schemas instead of zod.
 *
 * In the real migration this lives in @aeye/gin as `Type.toA()` next to
 * (then replacing) `Type.toValueSchema()`; here it works on the TypeDef JSON
 * (structurally the same `TypeDef` gin serializes) so the POC needs no gin
 * build. Two halves:
 *
 * - TYPE level: `GinSchema<T>` maps a `const` TypeDef literal to the exact
 *   `a` class, so `a.infer` of a converted gin type is the gin type's code
 *   shape (`fromGin({name:'list', generic:{V:{name:'num'}}})` → `ArrayType<NumberType>`).
 * - RUNTIME: `fromGin(def)` builds it; a named (registered) gin type becomes
 *   `a.ref(name)`; `ginNamedTypes(registry)` turns a registry's named types
 *   into the defs a chain's dynamic step returns.
 *
 * Differences from `toValueSchema` (deliberate):
 * - `map<text, V>` is a RECORD in the code shape. The pairs encoding is the
 *   profile's job (strict models still see `[{key, value}]`); gin's runtime
 *   reads a record. `map<K, V>` with a non-text key stays pairs in the code
 *   shape too (JSON has no non-string keys).
 * - Named types are refs into `$defs`, not `z.lazy` + `aid` meta.
 */
import {
  AnyType, ArrayType, BooleanType, EnumType, LiteralType, NullType, NullableType, NumberType, ObjectType,
  OptionalType, RecordType, RefType, StringType, TupleType, UnionType, type AnySchema, type LiteralValue, type SchemaOf,
} from '../schema';

/** Structurally gin's `TypeDef` (packages/gin/src/schema.ts). */
export interface GinTypeDef {
  readonly name: string;
  readonly docs?: string;
  readonly generic?: { readonly [key: string]: GinTypeDef };
  readonly options?: { readonly [key: string]: unknown };
  readonly props?: { readonly [key: string]: { readonly type: GinTypeDef; readonly docs?: string } };
}

type Props<P> = { [K in keyof P]: P[K] extends { readonly type: infer T } ? GinSchema<T> : never };

/** The `a` class for a gin TypeDef literal. Unknown names are named types → refs. */
export type GinSchema<T> =
  T extends { readonly name: 'text' } ? StringType
  : T extends { readonly name: 'num' } ? NumberType
  : T extends { readonly name: 'bool' } ? BooleanType
  : T extends { readonly name: 'null' | 'void' } ? NullType
  : T extends { readonly name: 'any' } ? AnyType<unknown>
  : T extends { readonly name: 'date' | 'timestamp' | 'duration' | 'color' } ? StringType
  : T extends { readonly name: 'list'; readonly generic: { readonly V: infer V } } ? ArrayType<GinSchema<V>>
  : T extends { readonly name: 'map'; readonly generic: { readonly V: infer V; readonly K: { readonly name: 'text' } } } ? RecordType<GinSchema<V>>
  : T extends { readonly name: 'map'; readonly generic: { readonly V: infer V; readonly K: infer K } } ? ArrayType<ObjectType<{ key: GinSchema<K>; value: GinSchema<V> }>>
  : T extends { readonly name: 'map'; readonly generic: { readonly V: infer V } } ? RecordType<GinSchema<V>>
  : T extends { readonly name: 'optional'; readonly generic: { readonly T: infer I } } ? OptionalType<GinSchema<I>>
  : T extends { readonly name: 'nullable'; readonly generic: { readonly T: infer I } } ? NullableType<GinSchema<I>>
  : T extends { readonly name: 'obj'; readonly props: infer P } ? ObjectType<Props<P>>
  : T extends { readonly name: 'enum'; readonly options: { readonly values: infer V } } ? EnumType<[V[keyof V] & string, ...(V[keyof V] & string)[]]>
  : T extends { readonly name: 'literal'; readonly options: { readonly value: infer V extends LiteralValue } } ? LiteralType<V>
  : T extends { readonly name: 'or'; readonly options: { readonly types: infer O extends readonly unknown[] } } ? UnionType<{ [I in keyof O]: GinSchema<O[I]> } & [AnySchema, ...AnySchema[]]>
  : T extends { readonly name: 'typ' } ? RefType<'TypeDef'>
  : T extends { readonly name: 'fn' } ? RefType<'Expr'>
  : T extends { readonly name: infer N extends string } ? RefType<N>
  : AnySchema;

/** Gin type names with their own `a` mapping; anything else is a named (registered) type. */
export const GIN_BUILTINS = new Set([
  'text', 'num', 'bool', 'null', 'void', 'any', 'date', 'timestamp', 'duration', 'color',
  'list', 'map', 'optional', 'nullable', 'obj', 'enum', 'literal', 'or', 'tuple', 'typ', 'fn',
  'and', 'not', 'iface', 'alias',
]);

/** Convert one gin TypeDef. */
export function fromGin<const T extends GinTypeDef>(def: T): GinSchema<T>;
export function fromGin(def: GinTypeDef): AnySchema {
  let s = convert(def);
  if (def.docs) s = s.describe(def.docs);
  return s;
}

function convert(def: GinTypeDef): AnySchema {
  const o = (def.options ?? {}) as Record<string, any>;
  const g = def.generic ?? {};
  switch (def.name) {
    case 'text': {
      let s = new StringType();
      if (typeof o.minLength === 'number') s = s.min(o.minLength);
      if (typeof o.maxLength === 'number') s = s.max(o.maxLength);
      if (typeof o.pattern === 'string') s = s.pattern(o.pattern);
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
    case 'date': return new StringType().format('date');
    case 'timestamp': return new StringType().format('date-time');
    case 'duration': return new StringType().format('duration');
    case 'color': return new StringType().pattern('^#[0-9a-fA-F]{6}$');
    case 'list': {
      let s = new ArrayType(g.V ? fromGin(g.V) : new AnyType());
      if (typeof o.minLength === 'number') s = s.min(o.minLength);
      if (typeof o.maxLength === 'number') s = s.max(o.maxLength);
      return s;
    }
    case 'map': {
      const V = g.V ? fromGin(g.V) : new AnyType();
      if (!g.K || g.K.name === 'text') return new RecordType(V);
      return new ArrayType(new ObjectType({ key: fromGin(g.K), value: V }));
    }
    case 'optional': return new OptionalType(g.T ? fromGin(g.T) : new AnyType());
    case 'nullable': return new NullableType(g.T ? fromGin(g.T) : new AnyType());
    case 'obj': {
      const shape: Record<string, AnySchema> = {};
      for (const [k, p] of Object.entries(def.props ?? {})) {
        let s = fromGin(p.type);
        if (p.docs) s = s.describe(p.docs);
        shape[k] = s;
      }
      return new ObjectType(shape);
    }
    case 'enum': {
      const values = Object.values((o.values ?? {}) as Record<string, unknown>);
      if (values.length && values.every((v) => typeof v === 'string')) return new EnumType(values as [string, ...string[]]);
      return new UnionType(values.map((v) => new LiteralType(v as LiteralValue)) as unknown as [AnySchema, ...AnySchema[]]);
    }
    case 'literal': return new LiteralType(o.value as LiteralValue);
    case 'or': return new UnionType(((o.types ?? []) as GinTypeDef[]).map((t) => fromGin(t)) as unknown as [AnySchema, ...AnySchema[]]);
    case 'tuple': return new TupleType(((o.types ?? []) as GinTypeDef[]).map((t) => fromGin(t)) as unknown as [AnySchema, ...AnySchema[]]);
    // A value that IS a gin type / program: a ref into the grammar module (see coverage/gin-grammar.ts).
    case 'typ': return new RefType('TypeDef');
    case 'fn': return new RefType('Expr');
    case 'and':
    case 'not':
    case 'iface':
      // Open question (DESIGN.md): intersections/negations/interfaces have no faithful JSON Schema in strict dialects.
      return new AnyType().describe(`A value of gin type ${def.name}.`);
    default:
      return new RefType(def.name);
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
 */
export function ginNamedTypes<T extends Record<string, unknown> = {}>(
  registry: GinRegistryLike,
): { readonly [K in keyof T]: SchemaOf<T[K]> } & Record<string, AnySchema> {
  const out: Record<string, AnySchema> = {};
  for (const [name, def] of registry.named()) out[name] = fromGin(def);
  return out as { readonly [K in keyof T]: SchemaOf<T[K]> } & Record<string, AnySchema>;
}
