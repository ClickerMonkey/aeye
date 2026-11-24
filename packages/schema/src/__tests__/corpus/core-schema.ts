/**
 * @aeye/core's schema module (packages/core/src/schema/*), ported to `a`:
 * every schema the core schema tests build (strictify, toJSONSchema per
 * dialect, decodeWire, the any-value encodings, the cycle breaker, enum caps,
 * formats, size limits, no-defs, budgets, canExpress), written faithfully
 * from the zod, each with its source `file:line` and a proof of the code
 * type it produces.
 *
 * Source root: packages/core/src/__tests__/ (abbreviated `core:`).
 * Runtime tests: core-schema-*.test.ts next to this file.
 */
import { expectTypeOf } from 'expect-type';
import { a, type Bundle } from '../../index';
import type { JsonValue } from '../../types';

// ============================================================================
// schema-formats.test.ts — the descriptor matrix
// ============================================================================

// core:schema-formats.test.ts:79 — z.object({ name: z.string(), age: z.number().optional() })
export const NameAge = a.object({ name: a.string(), age: a.number().optional() });
expectTypeOf<a.infer<typeof NameAge>>().toEqualTypeOf<{ name: string; age?: number }>();

// core:schema-formats.test.ts:114 — z.object({ tags: z.record(z.string(), z.string()) })
export const Tags = a.object({ tags: a.record(a.string()) });
expectTypeOf<a.infer<typeof Tags>>().toEqualTypeOf<{ tags: Record<string, string> }>();

// core:schema-formats.test.ts:150 — z.object({ pair: z.tuple([z.string(), z.number(), z.boolean()]) })
export const Pair = a.object({ pair: a.tuple([a.string(), a.number(), a.boolean()]) });
expectTypeOf<a.infer<typeof Pair>>().toEqualTypeOf<{ pair: [string, number, boolean] }>();

// core:schema-formats.test.ts:184 — z.intersection(z.object({ a: z.string() }), z.object({ b: z.number() }))
export const AandB = a.intersection([a.object({ a: a.string() }), a.object({ b: a.number() })]);
expectTypeOf<a.infer<typeof AandB>>().toEqualTypeOf<{ a: string } & { b: number }>();

// core:schema-formats.test.ts:216 (also schema-any.test.ts:150, :155) — z.object({ data: z.any() })
export const AnyData = a.object({ data: a.unknown() });
expectTypeOf<a.infer<typeof AnyData>>().toEqualTypeOf<{ data: unknown }>();
// core:schema-formats.test.ts:655 — z.object({ data: z.unknown() }) (`a.json()` is the typed variant)
export const JsonData = a.object({ data: a.json() });
expectTypeOf<a.infer<typeof JsonData>>().toEqualTypeOf<{ data: JsonValue }>();

// core:schema-formats.test.ts:279, :287, :302 — z.object({ contact: z.email(), unique: z.uuid() })
export const Contact = a.object({ contact: a.string().format('email'), unique: a.string().format('uuid') });
expectTypeOf<a.infer<typeof Contact>>().toEqualTypeOf<{ contact: string; unique: string }>();

// core:schema-formats.test.ts:297 — z.object({ code: z.string().regex(/^[a-z]+$/) })
export const Code = a.object({ code: a.string().pattern('^[a-z]+$') });
expectTypeOf<a.infer<typeof Code>>().toEqualTypeOf<{ code: string }>();

// core:schema-formats.test.ts:396, :435 — z.object({ age: z.number().min(0).max(120) })
export const Age = a.object({ age: a.number().min(0).max(120) });
// core:schema-formats.test.ts:403, :442 — z.object({ name: z.string().min(2).max(50) })
export const Name = a.object({ name: a.string().min(2).max(50) });
// core:schema-formats.test.ts:410 — z.object({ tags: z.array(z.string()).min(1).max(10) })
export const BoundedTags = a.object({ tags: a.array(a.string()).min(1).max(10) });
expectTypeOf<a.infer<typeof Age>>().toEqualTypeOf<{ age: number }>();
expectTypeOf<a.infer<typeof Name>>().toEqualTypeOf<{ name: string }>();
expectTypeOf<a.infer<typeof BoundedTags>>().toEqualTypeOf<{ tags: string[] }>();

// core:schema-formats.test.ts:419 — z.object({ zebra: z.string(), apple: z.number(), mango: z.boolean() })
export const Ordered = a.object({ zebra: a.string(), apple: a.number(), mango: a.boolean() });
expectTypeOf<a.infer<typeof Ordered>>().toEqualTypeOf<{ zebra: string; apple: number; mango: boolean }>();

// core:schema-formats.test.ts:549 — z.object({ name: z.string(), tags: z.record(z.string(), z.string()) })
export const NameTags = a.object({ name: a.string(), tags: a.record(a.string()) });
expectTypeOf<a.infer<typeof NameTags>>().toEqualTypeOf<{ name: string; tags: Record<string, string> }>();

// core:schema-formats.test.ts:663 — z.object({ a: z.any(), b: z.any(), c: z.array(z.any()) })
export const ThreeAny = a.object({ a: a.unknown(), b: a.unknown(), c: a.array(a.unknown()) });
expectTypeOf<a.infer<typeof ThreeAny>>().toEqualTypeOf<{ a: unknown; b: unknown; c: unknown[] }>();

// core:schema-formats.test.ts:1036 — z.object({ attrs: z.record(z.string(), z.number()) })
export const Attrs = a.object({ attrs: a.record(a.number()) });
// core:schema-formats.test.ts:1041 — z.record(z.string().regex(/^x-/), z.number()): a constrained key.
// `a.record` keys are plain strings or an enum; a key PATTERN is `.patterns({ '^x-': V })` on an object.
export const XAttrs = a.object({ attrs: a.object({}).patterns({ '^x-': a.number() }).strict() });
expectTypeOf<a.infer<typeof Attrs>>().toEqualTypeOf<{ attrs: Record<string, number> }>();

// ---------------------------------------------------------------------------
// The cycle breaker (schema-formats.test.ts:689-1032): recursive shapes.
// ---------------------------------------------------------------------------

// core:schema-formats.test.ts:690 (also schema-budget.test.ts:59, schema-size-limits.test.ts:155) —
// type Node = { value: string; children?: Node[] }
export const ValueNode = a.define({ Node: a.object({ value: a.string(), children: a.array(a.ref('Node')).optional() }) }).result('Node');
export type ValueNode = a.infer<typeof ValueNode>;
expectTypeOf<ValueNode['value']>().toEqualTypeOf<string>();
expectTypeOf<ValueNode['children']>().toEqualTypeOf<ValueNode[] | undefined>();
expectTypeOf(ValueNode).toMatchTypeOf<Bundle<ValueNode, []>>();
expectTypeOf(ValueNode.bind).parameters.toEqualTypeOf<[]>();

// core:schema-formats.test.ts:744 — mutual recursion: type A = { name: string; b?: B }; type B = { tag: number; a?: A }
export const MutualAB = a
  .define({
    A: a.object({ name: a.string(), b: a.ref('B').optional() }),
    B: a.object({ tag: a.number(), a: a.ref('A').optional() }),
  })
  .result('A');
type MutualA = a.infer<typeof MutualAB>;
expectTypeOf<MutualA['name']>().toEqualTypeOf<string>();
expectTypeOf<NonNullable<MutualA['b']>['tag']>().toEqualTypeOf<number>();
expectTypeOf<NonNullable<NonNullable<MutualA['b']>['a']>>().toEqualTypeOf<MutualA>();

// core:schema-formats.test.ts:777 — gin-style aid recursion: type Tree = { label: string; left?: Tree; right?: Tree }
export const LabelTree = a
  .define({ Tree: a.object({ label: a.string(), left: a.ref('Tree').optional(), right: a.ref('Tree').optional() }) })
  .result('Tree');
type LabelTree = a.infer<typeof LabelTree>;
expectTypeOf<LabelTree['left']>().toEqualTypeOf<LabelTree | undefined>();

// core:schema-formats.test.ts:794 — Person shared twice, not cyclic: z.object({ author: Person, reviewer: Person })
export const Reviewed = a
  .define({ Person: a.object({ name: a.string(), age: a.number() }) })
  .result(a.object({ author: a.ref('Person'), reviewer: a.ref('Person') }));
expectTypeOf<a.infer<typeof Reviewed>>().toEqualTypeOf<{ author: { name: string; age: number }; reviewer: { name: string; age: number } }>();

// core:schema-formats.test.ts:844 — type Wrap = { inner?: Wrap }
export const Wrap = a.define({ Wrap: a.object({ inner: a.ref('Wrap').optional() }) }).result('Wrap');
type Wrap = a.infer<typeof Wrap>;
expectTypeOf<Wrap['inner']>().toEqualTypeOf<Wrap | undefined>();
// core:schema-formats.test.ts:846 — type Arr = { items: Arr[] }
export const Arr = a.define({ Arr: a.object({ items: a.array(a.ref('Arr')) }) }).result('Arr');
type Arr = a.infer<typeof Arr>;
expectTypeOf<Arr['items']>().toEqualTypeOf<Arr[]>();

// core:schema-formats.test.ts:887 — type T = T[]
export const SelfArray = a.define({ T: a.array(a.ref('T')) }).result('T');
type SelfArray = a.infer<typeof SelfArray>;
expectTypeOf<SelfArray[number]>().toEqualTypeOf<SelfArray>();

// core:schema-formats.test.ts:906 — type Node = { value: string; children: Node[] } (required children)
export const ChildrenNode = a.define({ Node: a.object({ value: a.string(), children: a.array(a.ref('Node')) }) }).result('Node');
type ChildrenNode = a.infer<typeof ChildrenNode>;
expectTypeOf<ChildrenNode['children']>().toEqualTypeOf<ChildrenNode[]>();

// core:schema-formats.test.ts:923 — type A = { kind: 'a'; b?: B }; type B = { kind: 'b'; a?: A }
export const KindAB = a
  .define({
    A: a.object({ kind: a.literal('a'), b: a.ref('B').optional() }),
    B: a.object({ kind: a.literal('b'), a: a.ref('A').optional() }),
  })
  .result('A');
type KindA = a.infer<typeof KindAB>;
expectTypeOf<KindA['kind']>().toEqualTypeOf<'a'>();
expectTypeOf<NonNullable<KindA['b']>['kind']>().toEqualTypeOf<'b'>();

// core:schema-formats.test.ts:947 — type T = number | { rest: T }
export const NumOrRest = a.define({ T: a.union([a.number(), a.object({ rest: a.ref('T') })]) }).result('T');
type NumOrRest = a.infer<typeof NumOrRest>;
expectTypeOf<Exclude<NumOrRest, number>['rest']>().toEqualTypeOf<NumOrRest>();

// core:schema-formats.test.ts:966 — type T = string | number | T[]
export const StrNumList = a.define({ T: a.union([a.string(), a.number(), a.array(a.ref('T'))]) }).result('T');
type StrNumList = a.infer<typeof StrNumList>;
expectTypeOf<Extract<StrNumList, unknown[]>[number]>().toEqualTypeOf<StrNumList>();

// core:schema-formats.test.ts:986 — type T = 'leaf' | { kid: T }
export const LeafOrKid = a.define({ T: a.union([a.literal('leaf'), a.object({ kid: a.ref('T') })]) }).result('T');
type LeafOrKid = a.infer<typeof LeafOrKid>;
expectTypeOf<Extract<LeafOrKid, string>>().toEqualTypeOf<'leaf'>();

// core:schema-formats.test.ts:1002 — type T = { a: { b: { c: T[] } } }
export const DeepABC = a.define({ T: a.object({ a: a.object({ b: a.object({ c: a.array(a.ref('T')) }) }) }) }).result('T');
type DeepABC = a.infer<typeof DeepABC>;
expectTypeOf<DeepABC['a']['b']['c'][number]>().toEqualTypeOf<DeepABC>();

// core:schema-formats.test.ts:1018 — type T = T[][]
export const ListOfLists = a.define({ T: a.array(a.array(a.ref('T'))) }).result('T');
type ListOfLists = a.infer<typeof ListOfLists>;
expectTypeOf<ListOfLists[number][number]>().toEqualTypeOf<ListOfLists>();

// ============================================================================
// schema-any.test.ts
// ============================================================================

// core:schema-any.test.ts:33 — z.object({ a: z.any(), b: z.any(), c: z.array(z.any()), d: z.object({ nested: z.any() }) })
export const ManyAny = a.object({ a: a.unknown(), b: a.unknown(), c: a.array(a.unknown()), d: a.object({ nested: a.unknown() }) });
expectTypeOf<a.infer<typeof ManyAny>>().toEqualTypeOf<{ a: unknown; b: unknown; c: unknown[]; d: { nested: unknown } }>();

// core:schema-any.test.ts:183 — z.any().describe('Arbitrary JSON value')
export const DescribedAny = a.unknown().describe('Arbitrary JSON value');

// core:schema-any.test.ts:207 — the api_signature tool (a real 400 from Gemini):
// z.object({ signature: z.object({ name: z.string() }).catchall(z.any()).describe('...') })
export const ApiSignature = a.object({
  signature: a.object({ name: a.string() })
    .rest(a.unknown())
    .describe('The signature of the API function being declared.'),
});
expectTypeOf<a.infer<typeof ApiSignature>['signature']['name']>().toEqualTypeOf<string>();
expectTypeOf<a.infer<typeof ApiSignature>['signature']['extraKey']>().toEqualTypeOf<unknown>();

// ============================================================================
// schema-no-defs.test.ts
// ============================================================================

// core:schema-no-defs.test.ts:28 — type NodeShape = { name: string; children: NodeShape[] }
export const NamedChildren = a.define({ Node: a.object({ name: a.string(), children: a.array(a.ref('Node')) }) }).result('Node');
type NamedChildren = a.infer<typeof NamedChildren>;
expectTypeOf<NamedChildren['children']>().toEqualTypeOf<NamedChildren[]>();
// core:schema-no-defs.test.ts:42 — z.object({ label: z.string(), tree: RecursiveNode }) (non-root cycle)
export const LabelledTree = a
  .define({ Node: a.object({ name: a.string(), children: a.array(a.ref('Node')) }) })
  .result(a.object({ label: a.string(), tree: a.ref('Node') }));
expectTypeOf<a.infer<typeof LabelledTree>['tree']>().toEqualTypeOf<NamedChildren>();
// core:schema-no-defs.test.ts:59 — a NAMED sub-schema (aid 'GoogleNamed') used twice
export const NamedTwice = a
  .define({ GoogleNamed: a.object({ a: a.string() }) })
  .result(a.object({ one: a.ref('GoogleNamed'), two: a.ref('GoogleNamed') }));
expectTypeOf<a.infer<typeof NamedTwice>>().toEqualTypeOf<{ one: { a: string }; two: { a: string } }>();
// core:schema-no-defs.test.ts:72 — an UNNAMED leaf shared between two properties
const shared = a.string();
export const SharedLeaf = a.object({ one: shared, two: shared });
expectTypeOf<a.infer<typeof SharedLeaf>>().toEqualTypeOf<{ one: string; two: string }>();

// ============================================================================
// schema-wire-records.test.ts
// ============================================================================

// core:schema-wire-records.test.ts:13 — a JSON Schema whose record crossed a wire (zod fromJSONSchema)
export const WIRE_RECORD_JSON = { type: 'object', properties: { props: { type: 'object', additionalProperties: { type: 'number' } } }, required: ['props'] } as const;
// core:schema-wire-records.test.ts:44 — a named union T (aid 'Type') referenced twice and recursively
export const WIRE_NAMED_UNION_JSON = {
  type: 'object',
  properties: { x: { description: 'first', $ref: '#/$defs/T' }, y: { $ref: '#/$defs/T' } },
  required: ['x', 'y'],
  $defs: {
    T: { $ref: '#/$defs/U' },
    U: { anyOf: [
      { type: 'object', properties: { name: { type: 'string', const: 'a' } }, required: ['name'] },
      { type: 'object', properties: { name: { type: 'string', const: 'b' }, inner: { $ref: '#/$defs/T' } }, required: ['name', 'inner'] },
    ] },
  },
} as const;
// core:schema-wire-records.test.ts:35 — a namespaced aid 'api/HttpHeader' used twice
export const HttpHeaders = a
  .define({ 'api/HttpHeader': a.object({ key: a.string() }) })
  .result(a.object({ a: a.ref('api/HttpHeader'), b: a.ref('api/HttpHeader') }));
expectTypeOf<a.infer<typeof HttpHeaders>>().toEqualTypeOf<{ a: { key: string }; b: { key: string } }>();

// ============================================================================
// wire-decode.test.ts — decodeWire (wire → code shape)
// ============================================================================

// core:wire-decode.test.ts:317 — z.object({ a: z.record(z.string(), z.number()) })
export const RecA = a.object({ a: a.record(a.number()) });
// core:wire-decode.test.ts:328 — z.object({ rec: z.record(z.string(), z.number()), n: z.number() })
export const RecN = a.object({ rec: a.record(a.number()), n: a.number() });
expectTypeOf<a.infer<typeof RecN>>().toEqualTypeOf<{ rec: Record<string, number>; n: number }>();
// core:wire-decode.test.ts:341 — z.object({ name: z.string(), note: z.string().optional() })
export const NameNote = a.object({ name: a.string(), note: a.string().optional() });
expectTypeOf<a.infer<typeof NameNote>>().toEqualTypeOf<{ name: string; note?: string }>();
// core:wire-decode.test.ts:348 — z.object({ m: z.record(z.string(), z.number()) })
export const RecM = a.object({ m: a.record(a.number()) });
// core:wire-decode.test.ts:360 — z.object({ point: z.tuple([z.number(), z.number(), z.string()]) })
export const Point = a.object({ point: a.tuple([a.number(), a.number(), a.string()]) });
expectTypeOf<a.infer<typeof Point>>().toEqualTypeOf<{ point: [number, number, string] }>();
// core:wire-decode.test.ts:366 — z.object({ rows: z.array(z.record(z.string(), z.number())) })
export const Rows = a.object({ rows: a.array(a.record(a.number())) });
expectTypeOf<a.infer<typeof Rows>>().toEqualTypeOf<{ rows: Record<string, number>[] }>();

// core:wire-decode.test.ts:378 — the symmetry schema, round-tripped per descriptor
export const Symmetry = a.object({
  id: a.string(),
  scores: a.record(a.number()),
  coord: a.tuple([a.number(), a.number()]),
  note: a.string().optional(),
  extra: a.string().optional(),
});
export type Symmetry = a.infer<typeof Symmetry>;
expectTypeOf<Symmetry>().toEqualTypeOf<{ id: string; scores: Record<string, number>; coord: [number, number]; note?: string; extra?: string }>();

// core:wire-decode.test.ts:426 — a union of objects, each carrying a record
export const KindMaps = a.union([
  a.object({ kind: a.literal('a'), amap: a.record(a.number()) }),
  a.object({ kind: a.literal('b'), bmap: a.record(a.string()) }),
]);
expectTypeOf<a.infer<typeof KindMaps>>().toEqualTypeOf<{ kind: 'a'; amap: Record<string, number> } | { kind: 'b'; bmap: Record<string, string> }>();

// core:wire-decode.test.ts:441 — z.object({ m: record, t: z.tuple([z.string(), z.number()]), opt: z.number().optional() })
export const MixedAnthropic = a.object({ m: a.record(a.number()), t: a.tuple([a.string(), a.number()]), opt: a.number().optional() });
expectTypeOf<a.infer<typeof MixedAnthropic>>().toEqualTypeOf<{ m: Record<string, number>; t: [string, number]; opt?: number }>();

// core:wire-decode.test.ts:451 — type N = { name: string; meta: Record<string, string>; children?: N[] }
export const MetaNode = a
  .define({ N: a.object({ name: a.string(), meta: a.record(a.string()), children: a.array(a.ref('N')).optional() }) })
  .result('N');
type MetaNode = a.infer<typeof MetaNode>;
expectTypeOf<MetaNode['meta']>().toEqualTypeOf<Record<string, string>>();
expectTypeOf<MetaNode['children']>().toEqualTypeOf<MetaNode[] | undefined>();

// core:wire-decode.test.ts:486 (Tool) and :533 (Prompt) — the schema handed to a custom `parse`:
// z.object({ args: z.record(z.string(), z.string()), limit: z.number().optional() })
export const ArgsLimit = a.object({ args: a.record(a.string()), limit: a.number().optional() });
export type ArgsLimit = a.infer<typeof ArgsLimit>;
expectTypeOf<ArgsLimit>().toEqualTypeOf<{ args: Record<string, string>; limit?: number }>();

// ============================================================================
// schema.test.ts — strictify / toJSONSchema
// ============================================================================

// core:schema.test.ts:35, :55, :84, :768, :888 — z.object({ name: z.string(), age: z.number().optional() }) is NameAge above.
// core:schema.test.ts:103, :783 — several optionals
export const ManyOptional = a.object({ required: a.string(), optional1: a.string().optional(), optional2: a.number().optional(), optional3: a.boolean().optional() });
expectTypeOf<a.infer<typeof ManyOptional>>().toEqualTypeOf<{ required: string; optional1?: string; optional2?: number; optional3?: boolean }>();
// core:schema.test.ts:128 — nested optional fields + an optional object
export const UserMetadata = a.object({
  user: a.object({ name: a.string(), email: a.string().optional() }),
  metadata: a.object({ tags: a.array(a.string()).optional() }).optional(),
});
expectTypeOf<a.infer<typeof UserMetadata>>().toEqualTypeOf<{ user: { name: string; email?: string }; metadata?: { tags?: string[] } }>();
// core:schema.test.ts:160 — z.object({ outer: z.object({ inner: z.string().optional() }) })
export const OuterInner = a.object({ outer: a.object({ inner: a.string().optional() }) });
// core:schema.test.ts:178 — z.object({ required: z.string(), optional: z.string().optional() })
export const RequiredOptional = a.object({ required: a.string(), optional: a.string().optional() });
// core:schema.test.ts:195, :826 — z.object({ items: z.array(z.object({ name: z.string(), value: z.number().optional() })) })
export const ItemValues = a.object({ items: a.array(a.object({ name: a.string(), value: a.number().optional() })) });
expectTypeOf<a.infer<typeof ItemValues>>().toEqualTypeOf<{ items: { name: string; value?: number }[] }>();
// core:schema.test.ts:216, :842 — z.object({ items: z.array(z.string()).optional() })
export const MaybeItems = a.object({ items: a.array(a.string()).optional() });
// core:schema.test.ts:232 — z.object({ data: z.record(z.string(), z.number().optional()) })
export const RecOfOptional = a.object({ data: a.record(a.number().optional()) });
// core:schema.test.ts:252 — z.object({ data: z.record(z.string(), z.string()).optional() })
export const MaybeData = a.object({ data: a.record(a.string()).optional() });
expectTypeOf<a.infer<typeof MaybeData>>().toEqualTypeOf<{ data?: Record<string, string> }>();
// core:schema.test.ts:268 — z.object({ value: z.union([{ type: 'a', data?: string }, { type: 'b', count?: number }]) })
export const UnionOpt = a.object({
  value: a.union([a.object({ type: a.literal('a'), data: a.string().optional() }), a.object({ type: a.literal('b'), count: a.number().optional() })]),
});
expectTypeOf<a.infer<typeof UnionOpt>['value']>().toEqualTypeOf<{ type: 'a'; data?: string } | { type: 'b'; count?: number }>();
// core:schema.test.ts:295 — z.discriminatedUnion('type', [{ type: 'text', content?: string }, { type: 'number', value?: number }])
export const ItemDU = a.object({
  item: a.discriminatedUnion('type', [a.object({ type: a.literal('text'), content: a.string().optional() }), a.object({ type: a.literal('number'), value: a.number().optional() })]),
});
expectTypeOf<a.infer<typeof ItemDU>['item']>().toEqualTypeOf<{ type: 'text'; content?: string } | { type: 'number'; value?: number }>();
// core:schema.test.ts:322, :990 — z.object({ value: z.string().nullable() })
export const NullableValue = a.object({ value: a.string().nullable() });
expectTypeOf<a.infer<typeof NullableValue>>().toEqualTypeOf<{ value: string | null }>();
// core:schema.test.ts:363 — z.string().nullable().optional()
export const NullableOptional = a.object({ name: a.string(), value: a.string().nullable().optional() });
expectTypeOf<a.infer<typeof NullableOptional>>().toEqualTypeOf<{ name: string; value?: string | null }>();
// core:schema.test.ts:399 — z.string().optional().nullable() (zod: string | undefined | null)
export const OptionalNullable = a.object({ name: a.string(), value: a.string().optional().nullable() });
expectTypeOf<a.infer<typeof OptionalNullable>['value']>().toEqualTypeOf<string | null | undefined>();
// core:schema.test.ts:435, :1082 — nested nullable: { user: { name, email: nullable, bio: nullable.optional } }
export const UserBio = a.object({ user: a.object({ name: a.string(), email: a.string().nullable(), bio: a.string().nullable().optional() }) });
expectTypeOf<a.infer<typeof UserBio>>().toEqualTypeOf<{ user: { name: string; email: string | null; bio?: string | null } }>();
// core:schema.test.ts:459 — z.object({ items: z.array(z.string().nullable()) })
export const NullableElements = a.object({ items: a.array(a.string().nullable()) });
// core:schema.test.ts:473 — z.object({ items: z.array(z.string().nullable()).nullable() })
export const NullableList = a.object({ items: a.array(a.string().nullable()).nullable() });
expectTypeOf<a.infer<typeof NullableList>>().toEqualTypeOf<{ items: (string | null)[] | null }>();
// core:schema.test.ts:495 — z.object({ data: z.intersection({ a: string }, { b?: number }) })
export const InterOpt = a.object({ data: a.intersection([a.object({ a: a.string() }), a.object({ b: a.number().optional() })]) });
expectTypeOf<a.infer<typeof InterOpt>['data']>().toEqualTypeOf<{ a: string } & { b?: number }>();
// core:schema.test.ts:514 — z.object({ tuple: z.tuple([z.string(), z.number().optional()]) })
export const TupleOpt = a.object({ tuple: a.tuple([a.string(), a.number().optional()]) });
// core:schema.test.ts:531 — z.object({ value: z.string().default('default') })
export const WithDefault = a.object({ value: a.string().default('default') });
expectTypeOf<a.infer<typeof WithDefault>>().toEqualTypeOf<{ value: string }>();
// core:schema.test.ts:938 — z.object({ name: z.string(), role: z.string().default('user') })
export const RoleDefault = a.object({ name: a.string(), role: a.string().default('user') });
// core:schema.test.ts:556 — z.object({ root: nodeSchema }), node = { value: string; children?: Node[] }
export const RootNode = a
  .define({ Node: a.object({ value: a.string(), children: a.array(a.ref('Node')).optional() }) })
  .result(a.object({ root: a.ref('Node') }));
expectTypeOf<a.infer<typeof RootNode>['root']['children']>().toEqualTypeOf<a.infer<typeof RootNode>['root'][] | undefined>();
// core:schema.test.ts:591 — z.codec(z.object({ raw: z.string() }), z.object({ value: z.string().optional() }), ...)
export const CodecData = a.object({
  data: a.codec(a.object({ raw: a.string() }), {
    decode: (val): { value?: string } => ({ value: val.raw }),
    encode: (val: { value?: string }) => ({ raw: val.value || 'empty' }),
  }),
});
expectTypeOf<a.infer<typeof CodecData>>().toEqualTypeOf<{ data: { value?: string } }>();
// core:schema.test.ts:618 — z.pipe(z.string(), z.string().transform(toUpperCase)).optional()
export const Upper = a.object({ value: a.codec(a.string(), { decode: (s) => s.toUpperCase(), encode: (s: string) => s }).optional() });
expectTypeOf<a.infer<typeof Upper>>().toEqualTypeOf<{ value?: string }>();
// core:schema.test.ts:641-679 — primitives
export const StringValue = a.object({ value: a.string() });
export const NumberValue = a.object({ value: a.number() });
export const BooleanValue = a.object({ value: a.boolean() });
// core:schema.test.ts:685 — z.string().optional().describe('A test value')
export const DescribedOptional = a.object({ value: a.string().optional().describe('A test value') });
// core:schema.test.ts:925 — descriptions
export const Described = a.object({ name: a.string().describe('User name'), age: a.number().optional().describe('User age') });
// core:schema.test.ts:952 — enums, one optional
export const StatusPriority = a.object({ status: a.enum(['active', 'inactive']), priority: a.enum(['low', 'medium', 'high']).optional() });
expectTypeOf<a.infer<typeof StatusPriority>>().toEqualTypeOf<{ status: 'active' | 'inactive'; priority?: 'low' | 'medium' | 'high' }>();
// core:schema.test.ts:965 — an optional union
export const MaybeStrNum = a.object({ value: a.union([a.string(), a.number()]).optional() });
expectTypeOf<a.infer<typeof MaybeStrNum>>().toEqualTypeOf<{ value?: string | number }>();
// core:schema.test.ts:978 — z.object({ data: z.record(z.string(), z.number()) })
export const DataRecord = a.object({ data: a.record(a.number()) });
// core:schema.test.ts:1036 — mixed nullable, optional, nullable-optional and regular fields
export const Mixed = a.object({ required: a.string(), nullable: a.string().nullable(), optional: a.string().optional(), nullableOptional: a.string().nullable().optional() });
expectTypeOf<a.infer<typeof Mixed>>().toEqualTypeOf<{ required: string; nullable: string | null; optional?: string; nullableOptional?: string | null }>();
// core:schema.test.ts:1066 — z.object({ items: z.array(z.string()).nullable() })
export const NullableArray = a.object({ items: a.array(a.string()).nullable() });
// core:schema.test.ts:711-760 — open objects (catchall)
export const OpenAny = a.object({ name: a.string() }).rest(a.unknown());
export const OpenNum = a.object({ name: a.string() }).rest(a.number());
export const ClosedName = a.object({ name: a.string() }).strict();
export const PlainName = a.object({ name: a.string() });
export const OpenTagged = a.object({ name: a.string() }).rest(a.object({ tags: a.record(a.string()) }));
expectTypeOf<a.infer<typeof OpenNum>['name']>().toEqualTypeOf<string>();
expectTypeOf<a.infer<typeof OpenNum>['count']>().toEqualTypeOf<number>();
expectTypeOf<a.infer<typeof OpenTagged>['anything']>().toEqualTypeOf<{ tags: Record<string, string> }>();
// core:schema.test.ts:1107 — z.object({}) (a tool with no arguments)
export const Empty = a.object({});
expectTypeOf<a.infer<typeof Empty>>().toEqualTypeOf<{}>();
// core:schema.test.ts:1118 — deeply nested optional objects
export const Levels = a.object({ level1: a.object({ level2: a.object({ level3: a.object({ value: a.string().optional() }).optional() }).optional() }).optional() });
expectTypeOf<a.infer<typeof Levels>>().toEqualTypeOf<{ level1?: { level2?: { level3?: { value?: string } } } }>();
// core:schema.test.ts:1139 — required and optional at several levels
export const MultiLevel = a.object({
  required1: a.string(),
  optional1: a.string().optional(),
  nested: a.object({ required2: a.number(), optional2: a.number().optional(), deepNested: a.object({ required3: a.boolean(), optional3: a.boolean().optional() }) }),
});
// core:schema.test.ts:1164 — the end-to-end workflow
export const Workflow = a.object({
  id: a.string(),
  name: a.string(),
  email: a.string().optional(),
  age: a.number().optional(),
  settings: a.object({ theme: a.string(), notifications: a.boolean().optional() }),
});
expectTypeOf<a.infer<typeof Workflow>>().toEqualTypeOf<{ id: string; name: string; email?: string; age?: number; settings: { theme: string; notifications?: boolean } }>();
// core:schema.test.ts:1214 — z.object({ users: z.array(z.object({ name, email? })) })
export const Users = a.object({ users: a.array(a.object({ name: a.string(), email: a.string().optional() })) });

// ---------------------------------------------------------------------------
// The cletus "type helper" schemas (schema.test.ts:1239-1800): recursive
// where clauses, field conditions, field sets, a type's fields.
// ---------------------------------------------------------------------------

// core:schema.test.ts:1244 — whereSchema with getters (and/or/not) + name/age/active conditions, title TestType_where
export const TestTypeWhere = a
  .define({
    TestType_where: a.object({
      and: a.array(a.ref('TestType_where')).optional(),
      or: a.array(a.ref('TestType_where')).optional(),
      not: a.ref('TestType_where').optional(),
      name: a.object({ equals: a.string().optional(), contains: a.string().optional() }).optional(),
      age: a.object({ equals: a.number().optional(), gte: a.number().optional() }).optional(),
      active: a.object({ equals: a.boolean().optional() }).optional(),
    }),
  })
  .result('TestType_where');
export interface TestTypeWhereT {
  and?: TestTypeWhereT[];
  or?: TestTypeWhereT[];
  not?: TestTypeWhereT;
  name?: { equals?: string; contains?: string };
  age?: { equals?: number; gte?: number };
  active?: { equals?: boolean };
}
// core:schema.test.ts:1307 / :1360 — the same clause written with z.lazy (no getters): the
// test's own `type Where` is the expected code type (no `active`).
export const WhereFixed = a
  .define({
    TestType_where_fixed: a.object({
      and: a.array(a.ref('TestType_where_fixed')).optional(),
      or: a.array(a.ref('TestType_where_fixed')).optional(),
      not: a.ref('TestType_where_fixed').optional(),
      name: a.object({ equals: a.string().optional(), contains: a.string().optional() }).optional(),
      age: a.object({ equals: a.number().optional(), gte: a.number().optional() }).optional(),
    }),
  })
  .result('TestType_where_fixed');
type WhereClauseType = {
  and?: WhereClauseType[];
  or?: WhereClauseType[];
  not?: WhereClauseType;
  name?: { equals?: string; contains?: string };
  age?: { equals?: number; gte?: number };
};
expectTypeOf<WhereClauseType>().toMatchTypeOf<a.infer<typeof WhereFixed>>();
expectTypeOf<a.infer<typeof WhereFixed>>().toMatchTypeOf<WhereClauseType>();
// core:schema.test.ts:1432 — the parse case: age also has `lte`, no `active`
export const WhereLte = a
  .define({
    TestType_where: a.object({
      and: a.array(a.ref('TestType_where')).optional(),
      or: a.array(a.ref('TestType_where')).optional(),
      not: a.ref('TestType_where').optional(),
      name: a.object({ equals: a.string().optional(), contains: a.string().optional() }).optional(),
      age: a.object({ equals: a.number().optional(), gte: a.number().optional(), lte: a.number().optional() }).optional(),
    }),
  })
  .result('TestType_where');
expectTypeOf<NonNullable<a.infer<typeof WhereLte>['age']>>().toEqualTypeOf<{ equals?: number; gte?: number; lte?: number }>();
// core:schema.test.ts:1738 — empty where clauses: and/or/name only
export const WhereAndOr = a
  .define({
    W: a.object({
      and: a.array(a.ref('W')).optional(),
      or: a.array(a.ref('W')).optional(),
      name: a.object({ equals: a.string().optional() }).optional(),
    }),
  })
  .result('W');
// core:schema.test.ts:1767 — logical operators only: and/or/not/status
export const WhereStatus = a
  .define({
    W: a.object({
      and: a.array(a.ref('W')).optional(),
      or: a.array(a.ref('W')).optional(),
      not: a.ref('W').optional(),
      status: a.object({ equals: a.string().optional() }).optional(),
    }),
  })
  .result('W');
type TestTypeWhere = a.infer<typeof TestTypeWhere>;
expectTypeOf<TestTypeWhere['and']>().toEqualTypeOf<TestTypeWhere[] | undefined>();
expectTypeOf<TestTypeWhere['not']>().toEqualTypeOf<TestTypeWhere | undefined>();
expectTypeOf<TestTypeWhere['name']>().toEqualTypeOf<{ equals?: string; contains?: string } | undefined>();
// The recursive interface and the inferred type are interchangeable.
expectTypeOf<TestTypeWhereT>().toMatchTypeOf<TestTypeWhere>();
expectTypeOf<TestTypeWhere>().toMatchTypeOf<TestTypeWhereT>();

// core:schema.test.ts:1481 — Task_where: status/priority conditions with and/or/not
export const TaskWhere = a
  .define({
    Task_where: a.object({
      and: a.array(a.ref('Task_where')).optional(),
      or: a.array(a.ref('Task_where')).optional(),
      not: a.ref('Task_where').optional(),
      status: a.object({ equals: a.string().optional() }).optional(),
      priority: a.object({ equals: a.number().optional() }).optional(),
    }),
  })
  .result('Task_where');
type TaskWhere = a.infer<typeof TaskWhere>;
expectTypeOf<NonNullable<TaskWhere['priority']>['equals']>().toEqualTypeOf<number | undefined>();

// core:schema.test.ts:1601 — enum field conditions: an OPTIONAL object at the root
export const EnumCondition = a.object({
  equals: a.enum(['option1', 'option2', 'option3']).optional(),
  oneOf: a.array(a.enum(['option1', 'option2', 'option3'])).optional(),
  isEmpty: a.boolean().optional(),
}).optional();
expectTypeOf<a.infer<typeof EnumCondition>>().toEqualTypeOf<{ equals?: 'option1' | 'option2' | 'option3'; oneOf?: ('option1' | 'option2' | 'option3')[]; isEmpty?: boolean } | undefined>();

// core:schema.test.ts:1622 — buildFieldSetSchema: an array of field/value assignments, title TestType_fieldset
export const FieldSet = a.array(a.union([
  a.object({ field: a.literal('name'), value: a.string() }),
  a.object({ field: a.literal('age'), value: a.number() }),
  a.object({ field: a.literal('active'), value: a.boolean() }),
])).title('TestType_fieldset');
expectTypeOf<a.infer<typeof FieldSet>>().toEqualTypeOf<({ field: 'name'; value: string } | { field: 'age'; value: number } | { field: 'active'; value: boolean })[]>();
// core:schema.test.ts:1652 — the parse case: age's value is nullable
export const FieldSetNullable = a.array(a.union([
  a.object({ field: a.literal('name'), value: a.string() }),
  a.object({ field: a.literal('age'), value: a.number().nullable() }),
]));

// core:schema.test.ts:1698 — a type's fields, title User_fields (z.iso.date() → format 'date')
export const UserFields = a.object({
  email: a.string(),
  age: a.number().nullable(),
  isAdmin: a.boolean().nullable(),
  role: a.enum(['user', 'moderator', 'admin']).nullable(),
  createdAt: a.string().format('date'),
}).title('User_fields');
expectTypeOf<a.infer<typeof UserFields>>().toEqualTypeOf<{ email: string; age: number | null; isAdmin: boolean | null; role: 'user' | 'moderator' | 'admin' | null; createdAt: string }>();
// core:schema.test.ts:1727 — field names, title User_fieldNames
export const UserFieldNames = a.enum(['name', 'email', 'age', 'active']).title('User_fieldNames');
expectTypeOf<a.infer<typeof UserFieldNames>>().toEqualTypeOf<'name' | 'email' | 'age' | 'active'>();

// core:schema.test.ts:1802 — a registered id: z.object({ root: node }) with node meta({ id: 'StrictifyRegisteredNode' })
export const RegisteredRoot = a
  .define({ StrictifyRegisteredNode: a.object({ name: a.string(), children: a.array(a.ref('StrictifyRegisteredNode')).optional() }) })
  .result(a.object({ root: a.ref('StrictifyRegisteredNode') }));
type RegisteredRoot = a.infer<typeof RegisteredRoot>;
expectTypeOf<RegisteredRoot['root']['children']>().toEqualTypeOf<RegisteredRoot['root'][] | undefined>();

// core:schema.test.ts:1822 — z.object({ note: z.string().nullable(), tag: z.string().optional() })
export const NoteTag = a.object({ note: a.string().nullable(), tag: a.string().optional() });
expectTypeOf<a.infer<typeof NoteTag>>().toEqualTypeOf<{ note: string | null; tag?: string }>();

// ============================================================================
// schema-budget.test.ts / schema-size-limits.test.ts / can-express.test.ts
// ============================================================================

// core:schema-budget.test.ts:26 — z.object({ name, age?, address: { line1, line2? } })
export const Person = a.object({ name: a.string(), age: a.number().optional(), address: a.object({ line1: a.string(), line2: a.string().optional() }) });
expectTypeOf<a.infer<typeof Person>>().toEqualTypeOf<{ name: string; age?: number; address: { line1: string; line2?: string } }>();
// core:schema-budget.test.ts:39 — unions including nullables
export const PayloadMaybe = a.object({ payload: a.union([a.string(), a.number()]), maybe: a.string().nullable() });
expectTypeOf<a.infer<typeof PayloadMaybe>>().toEqualTypeOf<{ payload: string | number; maybe: string | null }>();
// core:schema-budget.test.ts:48 — records and tuples
export const TagsPair = a.object({ tags: a.record(a.string()), pair: a.tuple([a.string(), a.number()]) });
// core:schema-budget.test.ts:93 — z.object({ a: z.string() })
export const Simple = a.object({ a: a.string() });
// core:schema-budget.test.ts:146 — one optional
export const OneOptional = a.object({ a: a.string(), b: a.string().optional() });
// core:schema-budget.test.ts:163 — one union
export const OneUnion = a.object({ a: a.string(), b: a.union([a.string(), a.number()]) });
// core:schema-budget.test.ts:186-187
export const DataUnknown = a.object({ data: a.unknown() });
export const DataString = a.object({ data: a.string() });
// core:schema-budget.test.ts:196 — 25 optionals
export const optionals = (n: number) => a.object(Object.fromEntries(Array.from({ length: n }, (_, i) => [`f${i}`, a.string().optional()])));
// core:schema-budget.test.ts:205 — `wide`: one required + 13 optionals (b..n)
export const Wide13 = a.object({
  a: a.string(),
  b: a.string().optional(), c: a.string().optional(), d: a.string().optional(), e: a.string().optional(),
  f: a.string().optional(), g: a.string().optional(), h: a.string().optional(), i: a.string().optional(),
  j: a.string().optional(), k: a.string().optional(), l: a.string().optional(), m: a.string().optional(), n: a.string().optional(),
});
// core:schema-budget.test.ts:231 — the output schema
export const SmallX = a.object({ x: a.string() });
// core:schema-budget.test.ts:255 — z.object({ a: z.string().optional() })
export const OptionalA = a.object({ a: a.string().optional() });

// core:schema-size-limits.test.ts:30 — names(count, chars): distinct names, `chars` long each
export const names = (count: number, chars = 8): [string, ...string[]] =>
  Array.from({ length: count }, (_, i) => String(i).padStart(chars, 'n')) as [string, ...string[]];
// core:schema-size-limits.test.ts:116 — z.object({ a: z.enum(['xx','yy']), nested: z.object({ b: z.enum(['zzz']) }) })
export const TwoEnums = a.object({ a: a.enum(['xx', 'yy']), nested: a.object({ b: a.enum(['zzz']) }) });
// core:schema-size-limits.test.ts:130 — z.object({ tag: z.literal('fixed') })
export const FixedTag = a.object({ tag: a.literal('fixed') });
// core:schema-size-limits.test.ts:144 — depth/property counting
export const ABCDE = a.object({ a: a.string(), b: a.object({ c: a.string(), d: a.object({ e: a.string() }) }) });
// core:schema-size-limits.test.ts:154 — optional wrappers are transparent for depth
export const WrappedB = a.object({ a: a.object({ b: a.string() }).optional() });
export const BareB = a.object({ a: a.object({ b: a.string() }) });
// core:schema-size-limits.test.ts:162 — array element nesting
export const RowsX = a.object({ rows: a.array(a.object({ x: a.string() })) });
// core:schema-size-limits.test.ts:165 — names and enum values spend the string budget
export const Pick = a.object({ pick: a.enum(['alpha', 'beta']) });

// core:can-express.test.ts:21 — z.union([z.string(), z.number()]) (also as a field, :41)
export const StrOrNum = a.union([a.string(), a.number()]);
export const IdValue = a.object({ id: a.string(), value: a.union([a.string(), a.number()]) });
// core:can-express.test.ts:49 — a discriminated union
export const KindAorB = a.discriminatedUnion('kind', [a.object({ kind: a.literal('a'), a: a.string() }), a.object({ kind: a.literal('b'), b: a.number() })]);
// core:can-express.test.ts:57 — nullable/optional are not unions
export const NullOpt = a.object({ a: a.string().nullable(), b: a.number().optional() });
// core:can-express.test.ts:73 — a NON-root recursive ref: z.object({ inner: Inner }), Inner = { label, next: Inner }
export const InnerNext = a
  .define({ Inner: a.object({ label: a.string(), next: a.ref('Inner') }) })
  .result(a.object({ inner: a.ref('Inner') }));
type InnerNext = a.infer<typeof InnerNext>;
expectTypeOf<InnerNext['inner']['next']['next']['label']>().toEqualTypeOf<string>();
// core:can-express.test.ts:101 — a plain schema every dialect can express
export const Plain = a.object({ name: a.string(), age: a.number(), tags: a.array(a.string()), meta: a.object({ active: a.boolean() }) });

// ============================================================================
// schema-rebuilt-lazy.test.ts — a recursive schema REBUILT from a live registry per call
// ============================================================================

// core:schema-rebuilt-lazy.test.ts:48 — node(): lazy getter that builds a fresh
// { name, child?: Node, children: Node[] } every call, tagged aid 'Node'. In `a` the
// registry-built part is the chain's dynamic step: rebuilt per bind, cached by key.
export interface Registry { readonly version: number; readonly calls: { n: number } }
export const RebuiltNode = a
  .declare<{ Node: { name: string; child?: unknown; children: unknown[] } }>()
  .dynamic((reg: Registry) => {
    reg.calls.n += 1;
    // A FRESH object graph every call, as a codegen layer builds it.
    return { Node: a.object({ name: a.string(), child: a.ref('Node').optional(), children: a.array(a.ref('Node')) }) };
  }, { key: (reg) => reg.version })
  .result(a.object({ label: a.string(), tree: a.ref('Node') }));
expectTypeOf(RebuiltNode.bind).parameters.toEqualTypeOf<[reg: Registry]>();
expectTypeOf<a.infer<typeof RebuiltNode>['tree']['name']>().toEqualTypeOf<string>();

// ============================================================================
// schema-enum-cap.test.ts
// ============================================================================

// core:schema-enum-cap.test.ts:41-43 — MANY (20 names) and FEW (the first 8)
export const MANY = Array.from({ length: 20 }, (_, i) => `name_${i}`) as [string, ...string[]];
export const FEW = MANY.slice(0, 8) as [string, ...string[]];
// core:schema-enum-cap.test.ts:84 — nested: z.object({ pick: z.enum(MANY), tags: z.array(z.enum(MANY)) })
export const PickTags = a.object({ pick: a.enum(MANY), tags: a.array(a.enum(MANY)) });
// core:schema-enum-cap.test.ts:96 — z.enum(MANY).describe('Which capability to attach.')
export const Capability = a.enum(MANY).describe('Which capability to attach.');
// core:schema-enum-cap.test.ts:105 — z.nativeEnum({ n0: 0, ..., n19: 19 }): a NUMERIC enum
export const NumericEnum = a.union(Array.from({ length: 20 }, (_, i) => a.literal(i)) as unknown as [ReturnType<typeof a.literal<number>>, ...ReturnType<typeof a.literal<number>>[]]);
// core:schema-enum-cap.test.ts:118 — z.literal('only')
export const Only = a.literal('only');
expectTypeOf<a.infer<typeof Only>>().toEqualTypeOf<'only'>();
