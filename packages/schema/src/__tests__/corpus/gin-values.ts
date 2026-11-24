/**
 * CORPUS: gin value schemas — every TypeDef kind's `toValueSchema` (the
 * value a model writes for a gin-typed slot: tool args, `create_var`
 * values, `test` args) converted with `fromGin`, and its code type through
 * `GinSchema<T>`.
 *
 * Sources (packages/gin/src):
 * - types/<kind>.ts `toValueSchema` — one per kind (lines cited per def);
 * - type.ts:1643 `valueObject` (obj/iface key handling), :1659 `describeType`;
 * - schema.ts:10 `TypeDef` (the JSON these defs are).
 *
 * Every def is written `as const` so `fromGin` sees the literal and
 * `GinSchema<T>` picks the exact `a` class. Where `fromGin` does not yet
 * convert a kind the way gin does, the type proof is a `@ts-expect-error
 * GAP` (it starts failing when the gap is fixed) and the runtime test is an
 * `it.fails('GAP: ...')` in gin-values.test.ts.
 */
import { expectTypeOf } from 'expect-type';
import { a, fromGin, type AnySchema, type GinTypeDef } from '../../index';

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

// types/text.ts:225 — z.string() + minLength/maxLength/regex(pattern, flags)
export const TextDef = { name: 'text', options: { minLength: 1, maxLength: 40, pattern: '^[a-z][a-z0-9-]*$' } } as const;
export const Text = fromGin(TextDef);
expectTypeOf<a.infer<typeof Text>>().toEqualTypeOf<string>();
// types/text.ts:229 — `flags` go into the RegExp (`new RegExp(pattern, flags)`).
export const TextFlagsDef = { name: 'text', options: { pattern: '^user-', flags: 'i' } } as const;
export const TextFlags = fromGin(TextFlagsDef);

// types/num.ts:271 — whole → int, min, max (precision/prefix/suffix are display-only)
export const NumDef = { name: 'num', options: { whole: true, min: 0, max: 100, prefix: '$' } } as const;
export const Num = fromGin(NumDef);
expectTypeOf<a.infer<typeof Num>>().toEqualTypeOf<number>();

// types/bool.ts:128
export const BoolDef = { name: 'bool', options: { trueText: 'yes', falseText: 'no' } } as const;
export const Bool = fromGin(BoolDef);
expectTypeOf<a.infer<typeof Bool>>().toEqualTypeOf<boolean>();

// types/null.ts:99 and types/void.ts:98 — both z.null()
export const Null = fromGin({ name: 'null' } as const);
export const Void = fromGin({ name: 'void' } as const);
expectTypeOf<a.infer<typeof Null>>().toEqualTypeOf<null>();
expectTypeOf<a.infer<typeof Void>>().toEqualTypeOf<null>();

// types/any.ts:109 — z.any()
export const Any = fromGin({ name: 'any' } as const);
expectTypeOf<a.infer<typeof Any>>().toEqualTypeOf<unknown>();

// types/date.ts:155 — z.string().regex(/^\d{4}-\d{2}-\d{2}/) (a PREFIX match: a datetime passes too)
export const DateT = fromGin({ name: 'date', options: { utc: true } } as const);
expectTypeOf<a.infer<typeof DateT>>().toEqualTypeOf<string>();
// types/timestamp.ts:132 — regex: date, `T` or space, HH:MM, optional :SS(.fff), optional zone
export const Timestamp = fromGin({ name: 'timestamp', options: { precision: 'ms' } } as const);
expectTypeOf<a.infer<typeof Timestamp>>().toEqualTypeOf<string>();
// types/duration.ts:122 — z.number(): milliseconds
export const Duration = fromGin({ name: 'duration' } as const);
// (was GAP gin-duration-ms, fixed in pass 2) gin's duration value is a number of ms; GinSchema says string.
expectTypeOf<a.infer<typeof Duration>>().toEqualTypeOf<number>();
// types/color.ts:143 — z.number().int().min(0).max(0xffffffff): 0xRRGGBB(AA) as one integer
export const Color = fromGin({ name: 'color', options: { hasAlpha: true } } as const);
// (was GAP gin-color-int, fixed in pass 2) gin's color value is a 32-bit integer; GinSchema says string.
expectTypeOf<a.infer<typeof Color>>().toEqualTypeOf<number>();

// types/enum.ts:174 — z.enum(values record): the VALUES are accepted
export const EnumDef = { name: 'enum', options: { values: { LOW: 'low', MID: 'mid', HIGH: 'high' } } } as const;
export const Enum = fromGin(EnumDef);
expectTypeOf<a.infer<typeof Enum>>().toEqualTypeOf<'low' | 'mid' | 'high'>();
// types/enum.ts:177 — numeric members (Record<string, string | number>)
export const NumEnumDef = { name: 'enum', generic: { V: { name: 'num' } }, options: { values: { ONE: 1, TWO: 2 } } } as const;
export const NumEnum = fromGin(NumEnumDef);
// (was GAP gin-enum-numeric-type, fixed in pass 2) GinSchema keeps only string members (`V & string`), so a numeric enum infers `never`.
expectTypeOf<a.infer<typeof NumEnum>>().toEqualTypeOf<1 | 2>();

// types/literal.ts:160 — z.literal(value)
export const Literal = fromGin({ name: 'literal', options: { value: 'task' } } as const);
expectTypeOf<a.infer<typeof Literal>>().toEqualTypeOf<'task'>();
export const NumLiteral = fromGin({ name: 'literal', options: { value: 42 } } as const);
expectTypeOf<a.infer<typeof NumLiteral>>().toEqualTypeOf<42>();

// ---------------------------------------------------------------------------
// Generic containers
// ---------------------------------------------------------------------------

// types/list.ts:274 — z.array(item) + min/max
export const ListDef = { name: 'list', generic: { V: { name: 'text' } }, options: { minLength: 1, maxLength: 5 } } as const;
export const List = fromGin(ListDef);
expectTypeOf<a.infer<typeof List>>().toEqualTypeOf<string[]>();

// types/map.ts:264 — z.array({ key, value }) for EVERY key type (fromGin: text keys → a record; the
// pairs are the profile's job — a deliberate, documented difference).
export const MapTextDef = { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } } as const;
export const MapText = fromGin(MapTextDef);
expectTypeOf<a.infer<typeof MapText>>().toEqualTypeOf<Record<string, number>>();
export const MapNumDef = { name: 'map', generic: { K: { name: 'num' }, V: { name: 'text' } } } as const;
export const MapNum = fromGin(MapNumDef);
expectTypeOf<a.infer<typeof MapNum>>().toEqualTypeOf<{ key: number; value: string }[]>();

// types/optional.ts:171 / nullable.ts:162
export const Optional = fromGin({ name: 'optional', generic: { T: { name: 'num' } } } as const);
expectTypeOf<a.infer<typeof Optional>>().toEqualTypeOf<number | undefined>();
export const Nullable = fromGin({ name: 'nullable', generic: { T: { name: 'text' } } } as const);
expectTypeOf<a.infer<typeof Nullable>>().toEqualTypeOf<string | null>();

// types/tuple.ts:242 — z.tuple(elements) from `options.elements` (types/tuple.ts:66)
export const TupleDef = { name: 'tuple', options: { elements: [{ name: 'text' }, { name: 'num' }] } } as const;
// (was GAP gin-tuple, fixed in pass 2) GinSchema has no tuple case (and fromGin reads `options.types`, gin writes `options.elements`).
expectTypeOf<a.infer<ReturnType<typeof fromGin<typeof TupleDef>>>>().toEqualTypeOf<[string, number]>();

// ---------------------------------------------------------------------------
// Combinators
// ---------------------------------------------------------------------------

// types/or.ts:215 — z.union(variants)
export const OrDef = { name: 'or', options: { types: [{ name: 'text' }, { name: 'num' }, { name: 'null' }] } } as const;
export const Or = fromGin(OrDef);
expectTypeOf<a.infer<typeof Or>>().toEqualTypeOf<string | number | null>();

// types/and.ts:301 — z.intersection of the parts (objects merge)
export const AndDef = {
  name: 'and',
  options: { types: [
    { name: 'obj', props: { id: { type: { name: 'num', options: { whole: true } } } } },
    { name: 'obj', props: { label: { type: { name: 'text' } } } },
  ] },
} as const;
export const And = fromGin(AndDef);
expectTypeOf<a.infer<typeof And>>().toEqualTypeOf<{ id: number } & { label: string }>();

// types/not.ts:126 — z.any().refine(v => !excluded.safeParse(v).success)
export const NotDef = { name: 'not', options: { excluded: { name: 'null' } } } as const;
export const Not = fromGin(NotDef);
expectTypeOf<a.infer<typeof Not>>().toEqualTypeOf<unknown>();

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/** A realistic obj covering most kinds at once (gin's Task fixtures, build-schemas-named.test.ts:12). */
// types/obj.ts:314 — z.object(per-prop value schema); an optional<T> prop is an optional key.
export const TaskDef = {
  name: 'obj',
  docs: 'A work item.',
  props: {
    title: { type: { name: 'text', options: { minLength: 1 } }, docs: 'Short summary.' },
    points: { type: { name: 'num', options: { whole: true, min: 0 } } },
    done: { type: { name: 'bool' } },
    tags: { type: { name: 'list', generic: { V: { name: 'text' } }, options: { maxLength: 5 } } },
    weights: { type: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } }, docs: 'Weight per reviewer.' },
    byDay: { type: { name: 'map', generic: { K: { name: 'num' }, V: { name: 'text' } } } },
    note: { type: { name: 'optional', generic: { T: { name: 'text' } } } },
    due: { type: { name: 'nullable', generic: { T: { name: 'date' } } } },
    level: { type: { name: 'enum', options: { values: { LOW: 'low', HIGH: 'high' } } } },
    kind: { type: { name: 'literal', options: { value: 'task' } } },
    owner: { type: { name: 'or', options: { types: [{ name: 'text' }, { name: 'num' }] } } },
    extra: { type: { name: 'optional', generic: { T: { name: 'any' } } } },
  },
} as const;
export const Task = fromGin(TaskDef);
export interface TaskT {
  title: string;
  points: number;
  done: boolean;
  tags: string[];
  weights: Record<string, number>;
  byDay: { key: number; value: string }[];
  note?: string;
  due: string | null;
  level: 'low' | 'high';
  kind: 'task';
  owner: string | number;
  extra?: unknown;
}
expectTypeOf<a.infer<typeof Task>>().toEqualTypeOf<TaskT>();

// types/iface.ts:260 — a structural contract: passthrough object of the declared props.
// gin's class NAME is 'interface' (types/iface.ts:36), not 'iface'.
export const IfaceDef = { name: 'interface', props: { id: { type: { name: 'num' } }, label: { type: { name: 'text' } } } } as const;
// (was GAP gin-interface-name, fixed in pass 2) GinSchema maps 'iface', gin serializes 'interface' → it becomes a ref named "interface".
expectTypeOf<a.infer<ReturnType<typeof fromGin<typeof IfaceDef>>>>().toEqualTypeOf<{ id: number; label: string }>();

// ---------------------------------------------------------------------------
// Values that are types / programs: typ, fn
// ---------------------------------------------------------------------------

// types/typ.ts:163 — a TypeDef (gin's strict Type union + a parse refinement) → the grammar's TypeDef.
export const Typ = fromGin({ name: 'typ', generic: { T: { name: 'obj' } } } as const);
expectTypeOf(Typ).toMatchTypeOf<{ readonly kind: 'ref'; readonly name: 'TypeDef' }>();
// types/fn.ts:242 — z.union([z.string() (a native id), bag.Expr]) → the grammar's Expr.
export const Fn = fromGin({ name: 'fn', call: { args: { name: 'obj' } } } as const);
expectTypeOf(Fn).toMatchTypeOf<{ readonly kind: 'ref'; readonly name: 'Expr' }>();

// ---------------------------------------------------------------------------
// Named, registered and generic named types
// ---------------------------------------------------------------------------

// types/alias.ts:256 — a bare name resolves through the registry (lazily: recursion works).
export const TaskRef = fromGin({ name: 'Task' } as const);
expectTypeOf(TaskRef).toMatchTypeOf<{ readonly kind: 'ref'; readonly name: 'Task' }>();
// A generic named type at a use site: `Box<num>` (gin: AliasType + generic args; extension-generics.test.ts).
export const BoxOfNum = fromGin({ name: 'Box', generic: { T: { name: 'num' } } } as const);
expectTypeOf(BoxOfNum).toMatchTypeOf<{ readonly kind: 'ref'; readonly name: 'Box' }>();

// ---------------------------------------------------------------------------
// fn types: a method's args / returns (what a call step or the `test` tool sends)
// ---------------------------------------------------------------------------

/** The designer's create_new_fn example (ginny prompts/designer.ts:57): primeFactors(n: num{whole,min:1}): list<num>. */
export const PrimeFactorsDef = {
  name: 'fn',
  docs: 'Prime factors of n.',
  call: {
    args: { name: 'obj', props: { n: { type: { name: 'num', options: { whole: true, min: 1 } }, docs: 'The number to factor.' } } },
    returns: { name: 'list', generic: { V: { name: 'num' } } },
  },
} as const;
export const PrimeFactorsArgs = fromGin(PrimeFactorsDef.call.args);
export const PrimeFactorsReturns = fromGin(PrimeFactorsDef.call.returns);
expectTypeOf<a.infer<typeof PrimeFactorsArgs>>().toEqualTypeOf<{ n: number }>();
expectTypeOf<a.infer<typeof PrimeFactorsReturns>>().toEqualTypeOf<number[]>();

/** A method with optional and map args: `fetch(url: text, headers?: map<text,text>, timeout?: duration)`. */
export const FetchArgsDef = {
  name: 'obj',
  props: {
    url: { type: { name: 'text' }, docs: 'Absolute URL.' },
    method: { type: { name: 'optional', generic: { T: { name: 'enum', options: { values: { GET: 'GET', POST: 'POST' } } } } } },
    headers: { type: { name: 'optional', generic: { T: { name: 'map', generic: { K: { name: 'text' }, V: { name: 'text' } } } } } },
    body: { type: { name: 'optional', generic: { T: { name: 'any' } } } },
  },
} as const;
export const FetchArgs = fromGin(FetchArgsDef);
expectTypeOf<a.infer<typeof FetchArgs>>().toEqualTypeOf<{
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
}>();

// ---------------------------------------------------------------------------
// A TypeDef known only at runtime (a registry entry, a model-written type)
// ---------------------------------------------------------------------------

/** What ginny's test tool converts (ctx.targetFn's args): a `GinTypeDef`, not a literal. */
export function __runtimeDef(runtimeDef: GinTypeDef): void {
  // @ts-expect-error GAP fromGin-widened-type: `fromGin(def: GinTypeDef)` is typed RefType<string> (the "named type" case), not a schema of unknown output.
  expectTypeOf(fromGin(runtimeDef)).toEqualTypeOf<AnySchema>();
}
