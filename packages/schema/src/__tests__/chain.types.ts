/**
 * COMPILE-TIME proofs for the `a` builder and the chain. This file is
 * type-checked by `npm run test:types` (tsc -p tsconfig.typetest.json, with
 * `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` on); every
 * `@ts-expect-error` must be an error or tsc fails.
 */
import { expectTypeOf } from 'expect-type';
import { a, type Bindable, type Bundle } from '../index';

// ---------------------------------------------------------------------------
// 1. Plain schemas infer like zod
// ---------------------------------------------------------------------------

const Task = a.object({
  title: a.string(),
  done: a.boolean(),
  priority: a.enum(['low', 'high']),
  tags: a.record(a.number()),
  note: a.string().optional(),
  due: a.string().nullable(),
  pair: a.tuple([a.string(), a.int()]),
  kind: a.literal('task'),
  extra: a.json(),
});
type Task = a.infer<typeof Task>;
expectTypeOf<Task>().toEqualTypeOf<{
  title: string;
  done: boolean;
  priority: 'low' | 'high';
  tags: Record<string, number>;
  due: string | null;
  pair: [string, number];
  kind: 'task';
  extra: import('../types').JsonValue;
  note?: string;
}>();

// Optional means ABSENT, never `undefined` (exactOptionalPropertyTypes is on here).
// @ts-expect-error — a strict null comes back as a missing key, so `undefined` is not a valid value.
const _t1: Task = { title: '', done: true, priority: 'low', tags: {}, due: null, pair: ['', 1], kind: 'task', extra: 1, note: undefined };

// Known-key records are partial.
const Scores = a.record(a.enum(['a', 'b']), a.number());
expectTypeOf<a.infer<typeof Scores>>().toEqualTypeOf<Partial<Record<'a' | 'b', number>>>();

// Unions and discriminated unions.
const Shape = a.discriminatedUnion('kind', [
  a.object({ kind: a.literal('circle'), r: a.number() }),
  a.object({ kind: a.literal('rect'), w: a.number(), h: a.number() }),
]);
expectTypeOf<a.infer<typeof Shape>>().toEqualTypeOf<{ kind: 'circle'; r: number } | { kind: 'rect'; w: number; h: number }>();
// @ts-expect-error — every option must have the tag field.
a.discriminatedUnion('kind', [a.object({ kind: a.literal('x') }), a.object({ other: a.string() })]);

// Brands and codecs.
const Zone = a.string().brand<'Zone'>();
expectTypeOf<a.infer<typeof Zone>>().toMatchTypeOf<string>();
expectTypeOf<string>().not.toMatchTypeOf<a.infer<typeof Zone>>();
const FnName = a.codec(a.string(), { decode: (w) => ({ qualified: w.replace(/__/g, '/') }), encode: (v) => v.qualified.replace(/\//g, '__') });
expectTypeOf<a.infer<typeof FnName>>().toEqualTypeOf<{ qualified: string }>();

// Describe/example/refine keep the class (and its methods).
const Title = a.string().min(1).describe('Title').example('Buy milk');
expectTypeOf(Title).toEqualTypeOf<import('../schema').StringType>();
// @ts-expect-error — examples are typed in the code shape.
a.object({ n: a.number() }).example({ n: 'one' });

// ---------------------------------------------------------------------------
// 2. The chain: all refs defined statically, lazy (used before defined), recursive
// ---------------------------------------------------------------------------

const Tree = a
  .define({
    // `Node` uses itself and `Leaf`, which is defined in a LATER step.
    Node: a.object({ value: a.number(), children: a.array(a.ref('Node')), leaf: a.ref('Leaf').optional() }),
  })
  .define({ Leaf: a.object({ label: a.string() }) })
  .result('Node');

type Tree = a.infer<typeof Tree>;
expectTypeOf(Tree).toMatchTypeOf<Bundle<Tree, []>>();
declare const tree: Tree;
expectTypeOf(tree.value).toEqualTypeOf<number>();
expectTypeOf(tree.children).items.toHaveProperty('children');
expectTypeOf<NonNullable<Tree['children'][number]['children'][number]['leaf']>['label']>().toEqualTypeOf<string>();
const treeValue: Tree = { value: 1, children: [{ value: 2, children: [], leaf: { label: 'x' } }] };
// @ts-expect-error — recursion is checked all the way down.
const badTree: Tree = { value: 1, children: [{ value: '2', children: [] }] };

// Result is an inline object that uses refs.
const Forest = a
  .define({ Node: a.object({ value: a.number(), children: a.array(a.ref('Node')) }) })
  .result(a.object({ roots: a.array(a.ref('Node')), count: a.int() }));
type Forest = a.infer<typeof Forest>;
expectTypeOf<Forest['roots'][number]['children'][number]['value']>().toEqualTypeOf<number>();
expectTypeOf<Forest['count']>().toEqualTypeOf<number>();

// Mutual recursion across steps.
const Exprs = a
  .define({ Expr: a.discriminatedUnion('kind', [a.object({ kind: a.literal('num'), n: a.number() }), a.object({ kind: a.literal('add'), args: a.array(a.ref('Expr')) }), a.object({ kind: a.literal('block'), body: a.ref('Block') })]) })
  .define({ Block: a.object({ lines: a.array(a.ref('Expr')) }) })
  .result('Expr');
type Expr = a.infer<typeof Exprs>;
declare const e: Expr;
if (e.kind === 'block') {
  const first = e.body.lines[0];
  if (first?.kind === 'num') expectTypeOf(first.n).toEqualTypeOf<number>();
}

// ---------------------------------------------------------------------------
// 3. Using an undefined ref is a compile error
// ---------------------------------------------------------------------------

a.define({ Node: a.object({ next: a.ref('Ghost') }) })
  // @ts-expect-error — "Ghost" is used but never defined.
  .result('Node');

a.define({ Node: a.object({ v: a.number() }) })
  // @ts-expect-error — the result references an unknown name.
  .result(a.object({ x: a.ref('Nope') }));

a.define({ Node: a.object({ v: a.number() }) })
  // @ts-expect-error — the result names a type that is not defined.
  .result('Nope');

a.define({ A: a.string() })
  // @ts-expect-error — names cannot be redefined.
  .define({ A: a.number() });

// A schema with an unresolved ref can't be bound/rendered or given to a tool.
const loose = a.object({ x: a.ref('X') });
// @ts-expect-error — `bind` needs a ref-free schema.
loose.bind();
declare function takesBindable<O>(s: Bindable<O, []>): O;
// @ts-expect-error — unresolved ref.
takesBindable(loose);

// ---------------------------------------------------------------------------
// 4. Dynamic step: supplies the remaining refs from runtime args
// ---------------------------------------------------------------------------

interface Ctx { fields: string[]; registryVersion: number }

// 4a. The dynamic step's own return type types the ref.
const Query = a
  .define({ Filter: a.object({ field: a.ref('Field'), equals: a.string(), and: a.array(a.ref('Filter')).optional() }) })
  .dynamic((ctx: Ctx) => ({ Field: a.enum(ctx.fields as [string, ...string[]]) }), { key: (ctx) => ctx.registryVersion })
  .result(a.object({ where: a.ref('Filter'), limit: a.int().optional() }));
type Query = a.infer<typeof Query>;
expectTypeOf<Query['where']['field']>().toEqualTypeOf<string>();
expectTypeOf<NonNullable<Query['where']['and']>[number]['equals']>().toEqualTypeOf<string>();
expectTypeOf(Query.bind).parameters.toEqualTypeOf<[ctx: Ctx]>();

// 4b. `declare` pins the static type of a dynamic ref; the step must match it.
interface TypeDef { name: string; props?: Record<string, { type: TypeDef }> }
// The dynamic Type is recursive (uses itself) and built from the registry's names.
const EditType = a
  .declare<{ Type: TypeDef }>()
  .dynamic((registry: { names: [string, ...string[]] }) => ({
    Type: a.object({ name: a.enum(registry.names), props: a.record(a.object({ type: a.ref('Type') })).optional() }),
  }))
  .result(a.object({ name: a.string(), def: a.ref('Type') }));
expectTypeOf<a.infer<typeof EditType>>().toEqualTypeOf<{ name: string; def: TypeDef }>();

// 4c. A dynamic step that OMITS a remaining ref is an error.
a.define({ Filter: a.object({ field: a.ref('Field'), op: a.ref('Op') }) })
  // @ts-expect-error — "Op" is still missing.
  .dynamic((ctx: Ctx) => ({ Field: a.string() }));

// 4d. A dynamic step that returns the WRONG SHAPE for a declared ref is an error.
a.declare<{ Type: TypeDef }>()
  // @ts-expect-error — Type must decode to a TypeDef, not a number.
  .dynamic(() => ({ Type: a.number() }));

// 4d'. …including when the mismatch is only visible after resolving refs.
a.declare<{ Type: TypeDef }>()
  .dynamic(() => ({ Type: a.object({ name: a.ref('Name') }), Name: a.number() }))
  // @ts-expect-error — Type resolves to { name: number }, not a TypeDef.
  .result(a.object({ def: a.ref('Type') }));

// 4e. A dynamic step may not redefine a static name.
a.define({ Field: a.string() })
  // @ts-expect-error — "Field" is already defined statically.
  .dynamic(() => ({ Field: a.number() }));

// 4f. After `dynamic`, the result still can't use an unknown name.
a.define({ F: a.object({ x: a.ref('X') }) })
  .dynamic(() => ({ X: a.string() }))
  // @ts-expect-error — "Y" is never defined.
  .result(a.object({ f: a.ref('F'), y: a.ref('Y') }));

// 4g. A declared ref with no dynamic step is unresolved.
a.declare<{ Type: TypeDef }>()
  // @ts-expect-error — "Type" was declared but never supplied.
  .result(a.object({ def: a.ref('Type') }));

// 4h. Dynamic types may themselves reference static named types.
const Mixed = a
  .define({ Money: a.object({ amount: a.number(), currency: a.enum(['USD', 'EUR']) }) })
  .dynamic((cols: string[]) => ({ Row: a.record(a.ref('Money')) }))
  .result(a.object({ rows: a.array(a.ref('Row')) }));
expectTypeOf<a.infer<typeof Mixed>['rows'][number][string]['currency']>().toEqualTypeOf<'USD' | 'EUR'>();

// ---------------------------------------------------------------------------
// 5. Binding: dynamic args are typed; the bound/rendered output keeps Out
// ---------------------------------------------------------------------------

const bound = Query.bind({ fields: ['a'], registryVersion: 1 });
expectTypeOf(bound._out).toEqualTypeOf<Query>();
// @ts-expect-error — the dynamic part needs a Ctx.
Query.bind();
// @ts-expect-error — wrong ctx shape.
Query.bind({ fields: 'a' });
expectTypeOf(Tree.bind).parameters.toEqualTypeOf<[]>();

// Bindable is contravariant in args: a bundle needing Ctx fits a caller providing Ctx & more…
const ok: Bindable<Query, [Ctx & { user: string }]> = Query;
// …but not a caller that can't provide Ctx.
// @ts-expect-error — the caller's args lack `fields`.
const notOk: Bindable<Query, [{ registryVersion: number }]> = Query;

void [_t1, treeValue, badTree, ok, notOk];

// Recursive positions are real types, not `any` (error messages print them as `any[]` only for brevity).
expectTypeOf<Tree['children'][number]>().not.toBeAny();
expectTypeOf<Tree['children'][number]>().toEqualTypeOf<Tree>();
expectTypeOf<NonNullable<Query['where']['and']>[number]>().not.toBeAny();
expectTypeOf<NonNullable<Query['where']['and']>[number]>().toEqualTypeOf<Query['where']>();
