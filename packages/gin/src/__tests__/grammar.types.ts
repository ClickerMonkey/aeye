/**
 * Type proofs for gin's `a` grammar: each result decodes to its `GinShapes`
 * code type, and a tool's schema composed over the grammar infers exactly.
 * Compiled by `npm run test:types` (tsconfig.typetest.json).
 */
import { expectTypeOf } from 'expect-type';
import { a, fromGin } from '@aeye/schema';
import { ExprSchema, GinGrammar, TypeDefSchema, type GinShapes, type Registry, type BuildSchemasOverrides } from '../index';

expectTypeOf<a.infer<typeof TypeDefSchema>>().toEqualTypeOf<GinShapes.TypeDef>();
expectTypeOf<a.infer<typeof ExprSchema>>().toEqualTypeOf<GinShapes.ExprDef>();
expectTypeOf(ExprSchema.bind).parameters.toEqualTypeOf<[registry: Registry, overrides?: BuildSchemasOverrides]>();

const WriteArgs = GinGrammar.result(a.object({ program: a.ref('Expr') }));
expectTypeOf<a.infer<typeof WriteArgs>>().toEqualTypeOf<{ program: GinShapes.ExprDef }>();
const EditType = GinGrammar.result(a.object({ name: a.string(), def: a.ref('TypeDef') }));
expectTypeOf<a.infer<typeof EditType>>().toEqualTypeOf<{ name: string; def: GinShapes.TypeDef }>();

// Each built-in branch infers its code-side member.
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_num'>>>>().toEqualTypeOf<GinShapes.TypeNum>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Type_object'>>>>().toEqualTypeOf<GinShapes.TypeObject>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'CallDef'>>>>().toEqualTypeOf<GinShapes.CallDef>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'PathStep'>>>>().toEqualTypeOf<GinShapes.PathStep>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_loop'>>>>().toEqualTypeOf<GinShapes.LoopExpr>();
expectTypeOf<a.infer<ReturnType<typeof GinGrammar.result<'Expr_define'>>>>().toEqualTypeOf<GinShapes.DefineExpr>();

// A gin TypeDef literal's value type (the static side of `Type.toA()`): `fromGin` / `GinSchema<T>`.
const TaskDef = { name: 'obj', props: { title: { type: { name: 'text' } }, done: { type: { name: 'bool' } }, tags: { type: { name: 'list', generic: { V: { name: 'text' } } } }, due: { type: { name: 'optional', generic: { T: { name: 'date' } } } } } } as const;
expectTypeOf<a.infer<ReturnType<typeof fromGin<typeof TaskDef>>>>().toEqualTypeOf<{ title: string; done: boolean; tags: string[]; due?: string }>();
const MapDef = { name: 'map', generic: { K: { name: 'text' }, V: { name: 'num' } } } as const;
expectTypeOf<a.infer<ReturnType<typeof fromGin<typeof MapDef>>>>().toEqualTypeOf<Record<string, number>>();

export function __narrow(e: a.infer<typeof ExprSchema>): void {
  if (e.kind === 'define') expectTypeOf(e.vars[0]!.value).toEqualTypeOf<GinShapes.ExprDef>();
}
